"""Companion service core (plan 3.2): job store, source cache, workers, health. No HTTP here."""
import hashlib
import json
import os
import queue
import shutil
import sys
import threading
import time
import uuid

from . import ask, joblog
from .acquire import Source, acquire, unwrap, youtube_id
from .errors import DipDiveError
from .models import CLAUDE, CLAUDE_MODEL, CODEX, CODEX_HOME, CODEX_MODEL, call_model, ensure_codex_home
from .proc import run
from .prompts import PROMPT_VERSION

MODES = ("claude-dip", "claude-dive", "codex-dip", "codex-dive", "source") + ask.ASK_MODES
ACTIVE = ("queued", "fetching", "summarizing")
REQUIRED_KEYS = ("job_id", "request_id", "state", "pre_key", "norm_id", "url", "mode", "generation", "updated")
MAX_FETCH, MAX_MODEL, QUEUE_CAP, WORKERS = 2, 2, 20, 6
SOURCE_TTL, PRUNE_AFTER = 7 * 86400, 30 * 86400
SUPPORT = joblog.SUPPORT
LAUNCHD_LOGS = ("launchd.out.log", "launchd.err.log")


def _sha(*parts) -> str:
    return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()


def norm_source_id(url: str) -> str:
    """Cheap normalized source id for dedupe and the source cache (no network)."""
    u = unwrap(url.strip())
    vid, is_yt = youtube_id(u)
    if is_yt:
        return f"yt:{vid}" if vid else f"yt-invalid:{_sha(u)[:16]}"
    return u.split("#")[0]


def model_id(mode: str) -> str:
    return {"claude": CLAUDE_MODEL, "codex": CODEX_MODEL}.get(mode.split("-")[0], "none")


def _read_json(path):
    with open(path) as f:
        return json.load(f)


def _atomic_write(path: str, obj):
    tmp = f"{path}.{uuid.uuid4().hex[:6]}.tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class Service:
    def __init__(self, support=None, start_workers=True):
        self.dir = support or SUPPORT
        self.jobs_dir, self.src_dir, self.res_dir = (os.path.join(self.dir, d) for d in ("jobs", "sources", "results"))
        for d in (self.jobs_dir, self.src_dir, self.res_dir):
            os.makedirs(d, exist_ok=True)
        self.lock = threading.RLock()
        self.jobs = {}          # job_id -> record
        self.by_request = {}    # requestId -> job_id
        self.by_prekey = {}     # pre_key -> job_id (latest)
        self.inflight = {}      # norm source id -> (Event, [result])
        self.q = queue.Queue()
        self.fetch_sem = threading.Semaphore(MAX_FETCH)
        self.model_sem = threading.Semaphore(MAX_MODEL)
        self.state_path = os.path.join(self.dir, "state.json")
        self.generation = 0
        try:
            self.generation = int(_read_json(self.state_path).get("clear_generation", 0))
        except (OSError, ValueError):
            pass
        joblog.fence = lambda: self.generation
        self._load_jobs()
        self.prune()
        self._health = None
        self._health_at = 0.0
        self._health_refreshing = False
        if start_workers:
            for _ in range(WORKERS):
                threading.Thread(target=self._worker, daemon=True).start()
            threading.Thread(target=self._pruner, daemon=True).start()

    # ---------- persistence ----------
    def _load_jobs(self):
        for n in os.listdir(self.jobs_dir):
            if not n.endswith(".json"):
                continue
            try:
                j = _read_json(os.path.join(self.jobs_dir, n))
            except (OSError, ValueError):
                continue
            if (not isinstance(j, dict) or j.get("generation") != self.generation
                    or any(k not in j for k in REQUIRED_KEYS)):
                continue  # malformed or stale record: skip, never crash-loop the LaunchAgent
            if j["state"] in ACTIVE:
                j.update(state="error", error_code="interrupted", error_message="companion restarted during the job")
                self._save(j)
            self.jobs[j["job_id"]] = j
            self.by_request[j["request_id"]] = j["job_id"]
            if j["state"] in ACTIVE + ("done",):
                self.by_prekey[j["pre_key"]] = j["job_id"]

    def _save(self, j):
        """Write a job record unless a /clear happened since the job was created."""
        with self.lock:
            if j["generation"] != self.generation:
                return False
            j["updated"] = time.time()
            try:
                _atomic_write(os.path.join(self.jobs_dir, j["job_id"] + ".json"), j)
            except OSError as e:  # memory stays authoritative; a full disk must not kill workers
                print(f"dipdive: cannot save job {j['job_id']}: {e}", file=sys.stderr, flush=True)
                return False
            return True

    def _set(self, j, **kw):
        with self.lock:
            j.update(kw)
            self._save(j)

    # ---------- API ----------
    def submit(self, url, mode, request_id, force=False, question=None, history=None, summary=None):
        """Returns (http_status, body). Atomic check-and-enqueue under the lock. For the ask modes the question, the
        capped history and the summary shown are part of every key (raises ask.AskError on bad input)."""
        norm = norm_source_id(url)
        question, history, summary, qkey = ask.prepare(mode, question, history, summary)
        pre_key = _sha(norm, mode, model_id(mode), PROMPT_VERSION, *([qkey] if qkey else []))
        with self.lock:
            jid = self.by_request.get(request_id)
            if jid and jid in self.jobs:
                old = self.jobs[jid]
                if old["norm_id"] != norm or old["mode"] != mode or old.get("qkey") != qkey:
                    return 409, {"error_code": "request_id_conflict",
                                 "error_message": "requestId was already used for a different url, mode or question"}
                return 200, {"job_id": jid, "clear_generation": self.generation}
            if not force:
                jid = self.by_prekey.get(pre_key)
                j = self.jobs.get(jid) if jid else None
                if j and self._reusable(j):
                    self.by_request[request_id] = jid
                    return 200, {"job_id": jid, "clear_generation": self.generation}
            if sum(1 for x in self.jobs.values() if x["state"] in ACTIVE) >= QUEUE_CAP:
                return 429, {"error_code": "queue_full", "error_message": f"more than {QUEUE_CAP} jobs waiting"}
            j = {"job_id": uuid.uuid4().hex, "request_id": request_id, "pre_key": pre_key, "norm_id": norm,
                 "url": url, "mode": mode, "question": question, "history": history, "summary": summary, "qkey": qkey,
                 "state": "queued", "title": None, "result_markdown": None,
                 "error_code": None, "error_message": None, "force": bool(force),
                 "generation": self.generation, "created": time.time(), "updated": time.time()}
            self.jobs[j["job_id"]] = j
            self.by_request[request_id] = j["job_id"]
            self.by_prekey[pre_key] = j["job_id"]
            self._save(j)
        self.q.put(j["job_id"])
        return 202, {"job_id": j["job_id"], "clear_generation": self.generation}

    def _reusable(self, j):
        """Active jobs always; a done job only while its source is still cached and unchanged
        (plan 3.2.5.1: the source hash is part of the key)."""
        if j["generation"] != self.generation:
            return False
        if j["state"] in ACTIVE:
            return True
        if j["state"] != "done":
            return False
        src = self._read_source(j["norm_id"])
        return bool(src and src["hash"] == j.get("source_hash"))

    def public(self, j):
        return {"job_id": j["job_id"], "mode": j["mode"], "state": j["state"], "title": j["title"],
                "url": j["url"], "question": j.get("question"), "result_markdown": j["result_markdown"], "error_code": j["error_code"],
                "error_message": j["error_message"], "clear_generation": self.generation}

    def get_job(self, jid):
        with self.lock:
            j = self.jobs.get(jid)
            return self.public(j) if j else None

    def get_source_for_job(self, jid):
        with self.lock:
            j = self.jobs.get(jid)
        if not j:
            return 404, {"error_code": "no_such_job"}
        if not j.get("source_ready"):
            return 404, {"error_code": "source_not_fetched"}
        s = self._read_source(j["norm_id"])
        if not s:
            return 404, {"error_code": "source_gone", "error_message": "cached source expired or cleared"}
        return 200, {"title": s["title"], "url": s["url"], "text": s["text"], "clear_generation": self.generation}

    def clear(self):
        with self.lock, joblog.write_lock:
            self.generation += 1
            _atomic_write(self.state_path, {"clear_generation": self.generation})
            self.jobs.clear(); self.by_request.clear(); self.by_prekey.clear()
            for d in (self.jobs_dir, self.src_dir, self.res_dir, joblog.LOG_DIR):
                shutil.rmtree(d, ignore_errors=True)
            for d in (self.jobs_dir, self.src_dir, self.res_dir):
                os.makedirs(d, exist_ok=True)
            for n in LAUNCHD_LOGS:  # launchd appends tracebacks here; clear means clear
                try:
                    open(os.path.join(self.dir, n), "w").close()
                except OSError:
                    pass
            return {"clear_generation": self.generation}

    # ---------- source cache with coalescing ----------
    def _src_path(self, norm):
        return os.path.join(self.src_dir, _sha(norm)[:32] + ".json")

    def _read_source(self, norm):
        try:
            s = _read_json(self._src_path(norm))
        except (OSError, ValueError):
            return None
        if "hash" not in s or "fetched" not in s:
            return None  # entry from before the hash field existed: treat as expired, refetch
        if time.time() - s["fetched"] > SOURCE_TTL or s["generation"] != self.generation:
            return None
        return s

    def _get_source(self, j):
        norm, force, gen = j["norm_id"], j["force"], j["generation"]
        with self.lock:
            if not force:
                s = self._read_source(norm)
                if s:
                    return s
            ikey = (gen, norm)  # a job created after /clear must not join a pre-clear fetch
            ent = self.inflight.get(ikey)
            leader = ent is None
            if leader:
                ent = (threading.Event(), [])
                self.inflight[ikey] = ent
        if not leader:
            ent[0].wait()
            if isinstance(ent[1][0], Exception):
                raise ent[1][0]
            return ent[1][0]
        try:
            with self.fetch_sem:
                src = acquire(j["url"])
            s = {"norm_id": norm, "source_id": src.source_id, "title": src.title, "url": src.url,
                 "text": src.text, "meta": src.meta, "fetched": time.time(), "generation": gen,
                 "hash": hashlib.sha256(src.text.encode()).hexdigest()}
            with self.lock:
                if gen == self.generation:
                    _atomic_write(self._src_path(norm), s)
            ent[1].append(s)
            return s
        except BaseException as e:
            ent[1].append(e)
            raise
        finally:
            with self.lock:
                self.inflight.pop(ikey, None)
            ent[0].set()

    # ---------- workers ----------
    def _worker(self):
        while True:
            jid = self.q.get()
            try:
                with self.lock:
                    j = self.jobs.get(jid)
                if j:
                    self.run_one(j)
            except BaseException as e:  # a worker must never die: mark the job and keep looping
                try:
                    if j:
                        j.update(state="error", error_code="internal_error", error_message=f"{type(e).__name__}: {e}")
                        self._save(j)
                except BaseException:
                    pass
                print(f"dipdive: worker survived {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            finally:
                self.q.task_done()

    def wait_idle(self, timeout=30):
        """Block until no job is queued or running (used by tests before cleanup)."""
        end = time.time() + timeout
        while time.time() < end:
            with self.lock:
                if not any(v["state"] in ACTIVE for v in self.jobs.values()) and self.q.unfinished_tasks == 0:
                    return True
            time.sleep(0.05)
        return False

    def run_one(self, j):
        joblog.local.gen = j["generation"]
        try:
            self._set(j, state="fetching")
            s = self._get_source(j)
            self._set(j, title=s["title"], source_ready=True, source_hash=s["hash"])
            if j["mode"] == "source":
                self._set(j, state="done")
                return
            prov, level = j["mode"].split("-")
            fullkey = _sha(j["norm_id"], j["mode"], model_id(j["mode"]), PROMPT_VERSION,
                           s["hash"], *([j["qkey"]] if j.get("qkey") else []))
            rp = os.path.join(self.res_dir, fullkey + ".json")
            cached = None
            if not j["force"]:
                try:
                    cached = _read_json(rp)["result"]
                except (OSError, ValueError, KeyError):
                    pass
            if cached is None:
                self._set(j, state="summarizing")
                with self.model_sem:
                    cached = call_model(prov, level, s["title"], s["url"], s["text"],
                                        question=j.get("question"), history=j.get("history"),
                                        summary=j.get("summary"))
                with self.lock:
                    if j["generation"] == self.generation:
                        _atomic_write(rp, {"result": cached, "created": time.time()})
            self._set(j, state="done", result_markdown=cached)
        except DipDiveError as e:
            msg = e.message
            if e.code in ("auth", "quota", "rate_limited") and j["mode"] != "source":
                msg = f"{j['mode'].split('-')[0]}: {msg}"
            self._set(j, state="error", error_code=e.code, error_message=msg)
        except Exception as e:
            import traceback
            joblog.write({"internal_error": traceback.format_exc(), "url": j["url"], "mode": j["mode"]})
            self._set(j, state="error", error_code="internal_error", error_message=f"{type(e).__name__}: {e}")

    # ---------- pruning ----------
    def prune(self):
        now = time.time()
        for d, ttl in ((self.jobs_dir, PRUNE_AFTER), (self.res_dir, PRUNE_AFTER), (self.src_dir, SOURCE_TTL)):
            for n in os.listdir(d):
                p = os.path.join(d, n)
                try:
                    if now - os.path.getmtime(p) > ttl:
                        os.remove(p)
                except OSError:
                    pass
        with self.lock:
            for jid in [k for k, v in self.jobs.items()
                        if v["state"] not in ACTIVE and now - v["updated"] > PRUNE_AFTER]:
                del self.jobs[jid]
        joblog.prune()

    def _pruner(self):
        while True:
            time.sleep(3600)
            self.prune()

    # ---------- health (cached 60 s, stale-while-revalidate, no model calls) ----------
    def _compute_health(self):
        def cmd(args, env=None, t=15):
            try:
                r = run(args, t, env=env, max_bytes=100_000)
                return (r.text + r.err_text).strip()[:4000], r.rc
            except OSError as e:
                return f"{type(e).__name__}: {e}", -1
        ensure_codex_home()
        try:
            import yt_dlp.version as v
            ytv = v.__version__
        except Exception as e:
            ytv = f"unavailable: {e}"
        cenv = dict(os.environ, CODEX_HOME=CODEX_HOME)
        from .acquire import DENO
        cl, _ = cmd([CLAUDE, "--version"]); cas, crc = cmd([CLAUDE, "auth", "status"])
        iso_ok, iso_err = True, None
        try:
            from .models import verify_codex_features
            verify_codex_features(force=True)
        except DipDiveError as e:
            iso_ok, iso_err = False, e.message
        except Exception as e:
            iso_ok, iso_err = False, f"{type(e).__name__}: {e}"
        cx, _ = cmd([CODEX, "--version"]); cxs, cxrc = cmd([CODEX, "login", "status"], env=cenv)
        try:
            cl_logged = bool(json.loads(cas).get("loggedIn"))
        except ValueError:
            cl_logged = False
        return {"yt_dlp": ytv, "deno": cmd([DENO, "--version"])[0].splitlines()[0] if os.path.exists(DENO) else "missing",
                "claude": cl[:100], "codex": cx[:100], "claude_logged_in": cl_logged,
                "codex_logged_in": cxrc == 0 and "not logged in" not in cxs.lower(),
                "codex_isolation_ok": iso_ok, "codex_isolation_error": iso_err,
                "codex_ready": iso_ok and cxrc == 0 and "not logged in" not in cxs.lower(),
                "claude_auth_status": cas[:200], "codex_login_status": cxs[:200],
                "clear_generation": self.generation}

    def warm_health(self):
        """Start the first health computation in the background (called at server start)."""
        with self.lock:
            if self._health is None and not self._health_refreshing:
                self._health_refreshing = True
                threading.Thread(target=self._refresh_health, daemon=True).start()

    def health(self):
        """Never blocks: cached result, stale-while-revalidate after 60 s, {"state":"starting"} before the first."""
        with self.lock:
            if self._health is None:
                if not self._health_refreshing:
                    self._health_refreshing = True
                    threading.Thread(target=self._refresh_health, daemon=True).start()
                return {"state": "starting"}
            if time.time() - self._health_at < 60:
                return self._health
            if not self._health_refreshing:
                self._health_refreshing = True
                threading.Thread(target=self._refresh_health, daemon=True).start()
            return dict(self._health, stale=True)

    def _refresh_health(self):
        try:
            try:
                h = self._compute_health()
            except Exception as e:  # cache the failure for 60 s instead of recomputing on every call
                h = {"state": "error", "error": f"{type(e).__name__}: {e}"}
            with self.lock:
                self._health, self._health_at = h, time.time()
        finally:
            with self.lock:
                self._health_refreshing = False
