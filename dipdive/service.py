"""Companion service core (plan 3.2): job store, source cache, workers, health. No HTTP here."""
import errno
import hashlib
import json
import os
import queue
import shutil
import sys
import threading
import time
import tempfile
import uuid

from . import ask, historylog, joblog
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
WATCHED_SOURCE_TTL = 30 * 86400
WATCHED_QUEUE_CAP = 20
LIVE_STATUSES = {"is_live", "is_upcoming", "was_live", "post_live"}
SUPPORT = joblog.SUPPORT
LAUNCHD_LOGS = ("launchd.out.log", "launchd.err.log")
CLIPBOARD_MACHINES = ("thing-1", "thing-2", "imac", "win")
CLIPBOARD_TTL = 15 * 60
CLIPBOARD_CAP = 20


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
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix="DipDive atomic temporary ", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        dfd = os.open(os.path.dirname(path) or ".", os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


class Service:
    def __init__(self, support=None, start_workers=True):
        self.dir = support or SUPPORT
        self.jobs_dir, self.src_dir, self.res_dir = (os.path.join(self.dir, d) for d in ("jobs", "sources", "results"))
        self.removed_dir = os.path.join(self.dir, "history-removed")  # log entries unticked in the panel, kept to restore
        for d in (self.jobs_dir, self.src_dir, self.res_dir):
            os.makedirs(d, exist_ok=True)
        self.lock = threading.RLock()
        self.jobs = {}          # job_id -> record
        self.by_request = {}    # requestId -> job_id
        self.by_prekey = {}     # pre_key -> job_id (latest)
        self.inflight = {}      # norm source id -> (Event, [result])
        self.q = queue.Queue()
        self.watched_q = queue.Queue(maxsize=WATCHED_QUEUE_CAP)
        self.watched_pending = set()
        self.prefetch_q = queue.Queue(maxsize=WATCHED_QUEUE_CAP)
        self.prefetch_pending = set()
        self.watched_lock = threading.RLock()
        self.watched_index = os.path.join(self.dir, "watched-video-index.json")
        self.fetch_sem = threading.Semaphore(MAX_FETCH)
        self.model_sem = threading.Semaphore(MAX_MODEL)
        self.state_path = os.path.join(self.dir, "state.json")
        self.clipboard_path = os.path.join(self.dir, "clipboard-queue.json")
        self.generation = 0
        try:
            self.generation = int(_read_json(self.state_path).get("clear_generation", 0))
        except (OSError, ValueError):
            pass
        joblog.fence = lambda: self.generation
        self._load_jobs()
        try:  # once per start: sequence numbers for log entries written before they existed (see historylog.migrate)
            historylog.migrate()
        except Exception as e:
            print(f"dipdive: history log migration skipped: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        self.prune()
        self._health = None
        self._health_at = 0.0
        self._health_refreshing = False
        if start_workers:
            for _ in range(WORKERS):
                threading.Thread(target=self._worker, daemon=True).start()
            threading.Thread(target=self._watched_worker, daemon=True).start()
            threading.Thread(target=self._prefetch_worker, daemon=True).start()
            threading.Thread(target=self._pruner, daemon=True).start()

    def queue_watched(self, url):
        """Queue one YouTube video for transcript-only acquisition and recording."""
        url = unwrap(url.strip())
        from . import watched
        if watched.is_short_or_live_url(url):
            return 400, {"error_code": "bad_request", "error_message": "Shorts and live URLs are not recorded"}
        vid, is_yt = youtube_id(url)
        if not is_yt or not vid:
            return 400, {"error_code": "bad_request", "error_message": "url must identify a YouTube video"}
        # The history flock can block on another Dip. Never hold watched_lock while waiting;
        # prefetch uses that lock only to coordinate its own queue.
        with watched.locked(historylog.log_path()):
            recorded = vid in self._watched_ids() or watched.contains_video(watched.transcripts_dir(), vid)
        if recorded:
            return 200, {"queued": False, "recorded": True}
        with self.watched_lock:
            if vid in self.watched_pending:
                return 200, {"queued": False, "recorded": False}
            if len(self.watched_pending) >= WATCHED_QUEUE_CAP or self.watched_q.full():
                return 429, {"error_code": "queue_full", "error_message": "watched transcript queue is full"}
            self.watched_pending.add(vid)
            self.watched_q.put_nowait((vid, url))
        return 202, {"queued": True}

    def queue_watched_prefetch(self, url):
        """Queue a transcript-only fetch into the ordinary source cache."""
        url = unwrap(url.strip())
        from . import watched
        if watched.is_short_or_live_url(url):
            return 400, {"error_code": "bad_request", "error_message": "Shorts and live URLs are not prefetched"}
        vid, is_yt = youtube_id(url)
        if not is_yt or not vid:
            return 400, {"error_code": "bad_request", "error_message": "url must identify a YouTube video"}
        norm = f"yt:{vid}"
        with self.watched_lock:
            with self.lock:
                cached = self._read_source(norm)
            if cached:
                return 200, {"queued": False, "cached": True}
            if vid in self.prefetch_pending:
                return 200, {"queued": False, "cached": False}
            if len(self.prefetch_pending) >= WATCHED_QUEUE_CAP or self.prefetch_q.full():
                return 429, {"error_code": "queue_full", "error_message": "watched transcript queue is full"}
            self.prefetch_pending.add(vid)
            self.prefetch_q.put_nowait((vid, url))
        return 202, {"queued": True}

    def _watched_ids(self):
        try:
            with open(self.watched_index, encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, list) or any(not isinstance(x, str) for x in data):
                raise ValueError("invalid watched index")
            return set(data)
        except FileNotFoundError:
            return set()

    def _watched_worker(self):
        while True:
            vid, url = self.watched_q.get()
            try:
                self._record_watched_with_retry(vid, url)
            except BaseException as e:
                print(f"dipdive: watched transcript skipped {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            finally:
                with self.watched_lock:
                    self.watched_pending.discard(vid)
                self.watched_q.task_done()

    def _prefetch_worker(self):
        while True:
            vid, url = self.prefetch_q.get()
            try:
                self._prefetch_watched(vid, url)
            except BaseException as e:
                print(f"dipdive: watched transcript prefetch skipped {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            finally:
                with self.watched_lock:
                    self.prefetch_pending.discard(vid)
                self.prefetch_q.task_done()

    def _cache_source(self, vid, src, generation, ttl=SOURCE_TTL):
        norm = f"yt:{vid}"
        cached = {"norm_id": norm, "source_id": src.source_id, "title": src.title, "url": src.url,
                  "text": src.text, "meta": src.meta, "fetched": time.time(), "generation": generation,
                  "ttl": ttl, "hash": hashlib.sha256(src.text.encode()).hexdigest()}
        with self.lock:
            if self.generation == generation:
                existing = self._read_source(norm)
                if existing:
                    old_ttl = existing.get("ttl", SOURCE_TTL)
                    if type(old_ttl) is not int or old_ttl < SOURCE_TTL:
                        old_ttl = SOURCE_TTL
                    cached["ttl"] = max(ttl, old_ttl)
                _atomic_write(self._src_path(norm), cached)
        return cached

    @staticmethod
    def _watched_transient(error):
        if isinstance(error, historylog.LockUnavailable):
            return True
        if isinstance(error, (TimeoutError, ConnectionError)):
            return True
        return isinstance(error, DipDiveError) and error.code in {
            "fetch_failed", "timeout", "network", "rate_limited"
        }

    def _record_watched_with_retry(self, vid, url):
        """Retry transient watched-fetch and archive failures, then persist one job log entry."""
        delays = (60, 120)
        for attempt in range(3):
            try:
                return self._record_watched(vid, url)
            except Exception as error:
                if not self._watched_transient(error):
                    raise
                if attempt == 2:
                    joblog.write({"watched_transcript_error": f"{type(error).__name__}: {error}", "url": url})
                    return False
                time.sleep(delays[attempt])

    @staticmethod
    def _source_live(src):
        return (src.meta or {}).get("live_status") in LIVE_STATUSES

    def _prefetch_watched(self, vid, url):
        """Fetch captions in the background without touching watched archive/index state."""
        norm = f"yt:{vid}"
        with self.lock:
            generation = self.generation
            if self._read_source(norm):
                return False
        try:
            with self.fetch_sem:
                src = acquire(url)
        except DipDiveError as e:
            if e.code in ("live_in_progress", "no_captions"):
                return False
            raise
        if self._source_live(src) or not src.text or not src.text.strip():
            return False
        self._cache_source(vid, src, generation, SOURCE_TTL)
        return True

    def _record_watched(self, vid, url):
        """Acquire captions without a model call, then append and index under the history log lock."""
        from . import watched
        log_path = historylog.log_path()
        with self.lock:
            cache_generation = self.generation
        with watched.locked(log_path):
            if vid in self._watched_ids() or watched.contains_video(watched.transcripts_dir(log_path), vid):
                return False
        norm = f"yt:{vid}"
        with self.lock:
            cached = self._read_source(norm)
        if cached:
            src = Source("youtube", cached["source_id"], cached["title"], cached["url"], cached["text"], cached.get("meta"))
        else:
            with self.fetch_sem:
                try:
                    src = acquire(url)
                except DipDiveError as e:
                    if e.code in ("live_in_progress", "no_captions"):
                        return False
                    raise
        if self._source_live(src):
            return False
        if not src.text or not src.text.strip():
            return False
        with watched.locked(log_path):
            ids = self._watched_ids()
            if vid in ids:
                return False
            watched.append(src, url, directory=watched.transcripts_dir(log_path), when=time.time())
            ids.add(vid)
            _atomic_write(self.watched_index, sorted(ids))
        # A later Dip/Dive can use these captions for 30 days without another yt-dlp fetch.
        self._cache_source(vid, src, cache_generation, WATCHED_SOURCE_TTL)
        return True

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
    def queue_clipboard(self, url, machines):
        """Persist one expiring source URL for each machine, dropping oldest items over the cap."""
        now = time.time()
        with self.lock:
            original = self._read_clipboard_queues()
            queues = {machine: list(items) for machine, items in original.items()}
            for machine in CLIPBOARD_MACHINES:
                queues[machine] = [item for item in queues[machine]
                                   if isinstance(item, dict) and isinstance(item.get("url"), str)
                                   and isinstance(item.get("expires"), (int, float)) and item["expires"] > now]
            for machine in machines:
                queues[machine].append({"url": url, "created": now, "expires": now + CLIPBOARD_TTL})
                queues[machine] = queues[machine][-CLIPBOARD_CAP:]
            if queues != original:
                _atomic_write(self.clipboard_path, queues)
        return {"queued": list(machines)}

    def take_clipboard(self, machine):
        """Remove and return the newest unexpired URL for one machine."""
        now = time.time()
        with self.lock:
            original = self._read_clipboard_queues()
            queues = {name: list(items) for name, items in original.items()}
            queue_for_machine = [item for item in queues[machine]
                                 if isinstance(item, dict) and isinstance(item.get("url"), str)
                                 and isinstance(item.get("expires"), (int, float)) and item["expires"] > now]
            # Keep the full expiry window, but a returning helper only needs the latest link.
            result = queue_for_machine[-1] if queue_for_machine else None
            queues[machine] = []
            if queues != original:
                _atomic_write(self.clipboard_path, queues)
            return {"url": result["url"]} if result else None

    def _read_clipboard_queues(self):
        empty = {machine: [] for machine in CLIPBOARD_MACHINES}
        try:
            with open(self.clipboard_path) as f:
                saved = json.load(f)
        except (OSError, ValueError):
            return empty
        if not isinstance(saved, dict):
            return empty
        for machine in CLIPBOARD_MACHINES:
            items = saved.get(machine, [])
            empty[machine] = items if isinstance(items, list) else []
        return empty

    def submit(self, url, mode, request_id, force=False, question=None, history=None, summary=None, clear_generation=None):
        """Returns (http_status, body). Atomic check-and-enqueue under the lock. For the ask modes the question, the
        capped history and the summary shown are part of every key (raises ask.AskError on bad input).

        `clear_generation` is the generation the client last saw. One older than the current is refused with 409
        stale_clear_generation, and no job, history or log is made: the client's summary and thread were built on history
        a /clear (from another machine, say) has since removed. None means the client has seen no generation yet."""
        norm = norm_source_id(url)
        question, history, summary, qkey = ask.prepare(mode, question, history, summary)
        pre_key = _sha(norm, mode, model_id(mode), PROMPT_VERSION, *([qkey] if qkey else []))
        with self.lock:
            if clear_generation is not None and clear_generation < self.generation:
                return 409, {"error_code": "stale_clear_generation",
                             "error_message": "history was cleared since this client last synced",
                             "clear_generation": self.generation}
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
                "error_message": j["error_message"], "clear_generation": self.generation,
                # True while this summary's entry is in the history log, False while it is kept as removed (unticked in
                # the panel), None when it has none (asks, Temp chat, errors, a log failure, an entry deleted by hand)
                **self._saved_fields(j)}

    def _saved_fields(self, j):
        """history_saved and history_rev for a job answer. The revision is read before the state, so the state is never
        older than the revision it is labelled with; a panel applies an answer only when its revision is not older than
        the newest it has seen."""
        if not j.get("log_id"):
            return {"history_saved": None, "history_rev": historylog.revision()}
        rev = historylog.revision()
        return {"history_saved": historylog.saved_state(j["log_id"], self.removed_dir), "history_rev": rev}

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
        # The history log's write lock first (the same order as set_saved), so a remove or restore is never half done
        # around a clear: it finishes before, or it starts after and finds the new generation and no removed store.
        # required=False: Clear never writes the log, so it still works when the log's folder is missing or read-only
        with historylog.locked(required=False), self.lock, joblog.write_lock:
            self.generation += 1
            _atomic_write(self.state_path, {"clear_generation": self.generation})
            self.jobs.clear(); self.by_request.clear(); self.by_prekey.clear()
            for d in (self.jobs_dir, self.src_dir, self.res_dir, joblog.LOG_DIR, self.removed_dir):
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
        ttl = s.get("ttl", SOURCE_TTL)
        if type(ttl) is not int or ttl < SOURCE_TTL:
            ttl = SOURCE_TTL
        if time.time() - s["fetched"] > ttl or s["generation"] != self.generation:
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
            cached, log_id = None, None
            if not j["force"]:
                try:
                    stored = _read_json(rp)
                    cached, log_id = stored["result"], stored.get("log_id")
                except (OSError, ValueError, KeyError, TypeError):
                    pass
            fresh = cached is None  # only a result made by a model call just now is new; cache hits were logged already
            if cached is None:
                self._set(j, state="summarizing")
                with self.model_sem:
                    cached = call_model(prov, level, s["title"], s["url"], s["text"],
                                        question=j.get("question"), history=j.get("history"),
                                        summary=j.get("summary"))
                with self.lock:
                    if j["generation"] == self.generation:
                        _atomic_write(rp, {"result": cached, "created": time.time()})
            # Logged before the job reads as done, so a panel that sees "done" also sees whether it has a log entry.
            if fresh and j["mode"] in historylog.LOGGED_MODES and j["generation"] == self.generation:
                if self._log_history(j, s["title"], cached, (s.get("meta") or {}).get("channel")):
                    log_id = j["job_id"]
                    with self.lock:  # a later cache hit on this result points at the same entry
                        if j["generation"] == self.generation:
                            try:
                                _atomic_write(rp, {"result": cached, "created": time.time(), "log_id": log_id})
                            except OSError:
                                pass
            self._set(j, state="done", result_markdown=cached,
                      log_id=log_id if isinstance(log_id, str) and len(log_id) == 32 else None)
        except DipDiveError as e:
            msg = e.message
            if e.code in ("auth", "quota", "rate_limited") and j["mode"] != "source":
                msg = f"{j['mode'].split('-')[0]}: {msg}"
            self._set(j, state="error", error_code=e.code, error_message=msg)
        except Exception as e:
            import traceback
            joblog.write({"internal_error": traceback.format_exc(), "url": j["url"], "mode": j["mode"]})
            self._set(j, state="error", error_code="internal_error", error_message=f"{type(e).__name__}: {e}")

    def _log_history(self, j, title, summary, channel=None):
        """Append the finished summary to the durable history log, tagged with the job id. Returns True when it was
        written. Never raises: a log failure goes to the job log."""
        try:
            historylog.append(title or "", j["mode"], j["url"], summary, channel=channel, job_id=j["job_id"])
            return True
        except BaseException as e:
            try:
                joblog.write({"history_log_error": f"{type(e).__name__}: {e}", "path": historylog.log_path(),
                              "url": j["url"], "mode": j["mode"]})
            except BaseException:
                pass
            return False

    def set_saved(self, jid, saved, clear_generation=None):
        """POST /history/<id>/remove or /restore: take a summary's entry out of the history log or put it back.
        `jid` is a job id: the job's own entry, or for a job served from the result cache the entry of the job that made
        the result; an id with no job record (an older entry) is taken as the entry's own id. Idempotent. A request
        that carries a clear generation older than the current one is refused (409 stale_clear_generation): the summary
        it was made for belongs to history that has been cleared. The whole change runs under the log's write lock, the
        same lock Clear history takes first; when that lock cannot be had, nothing is changed (503 log_locked). The answer
        carries `history_rev`, the log's revision right after the change, so a panel can tell newer answers from older.
        Returns (http_status, body)."""
        with self.lock:  # a summary with no log entry needs no lock to say so
            j = self.jobs.get(jid)
            if j is not None and not j.get("log_id"):
                return 404, {"error_code": "not_logged", "error_message": "this summary has no entry in the history log"}
        try:
            return self._set_saved(jid, saved, clear_generation)
        except historylog.LockUnavailable as e:
            return 503, {"error_code": "log_locked", "error_message": f"the history log cannot be locked, so it was not changed ({e.strerror or e})"}

    def _set_saved(self, jid, saved, clear_generation):
        with historylog.locked():
            with self.lock:
                if clear_generation is not None and clear_generation < self.generation:
                    return 409, {"error_code": "stale_clear_generation",
                                 "error_message": "history was cleared since this client last synced",
                                 "clear_generation": self.generation}
                j = self.jobs.get(jid)
                log_id = (j.get("log_id") if j else jid) or None
            if not log_id:
                return 404, {"error_code": "not_logged", "error_message": "this summary has no entry in the history log"}
            try:
                now = (historylog.restore_entry if saved else historylog.remove_entry)(log_id, self.removed_dir)
            except historylog.NoSuchEntry:
                return 404, {"error_code": "no_such_entry", "error_message": "no history log entry has that id"}
            except historylog.AmbiguousEntry:
                return 409, {"error_code": "entry_ambiguous",
                             "error_message": "the entry runs into its neighbour (edited by hand?); the log was not changed"}
            except historylog.LogUnreadable as e:
                return 503, {"error_code": "log_unreadable", "error_message": f"the history log cannot be read ({e})"}
            except historylog.LockUnavailable:
                raise
            except OSError as e:
                return 503, {"error_code": "log_unwritable",
                             "error_message": f"the history log cannot be written ({errno.errorcode.get(e.errno, 'OSError')})"}
            rev = historylog.revision()
        return 200, {"job_id": jid, "saved": now, "clear_generation": self.generation, "history_rev": rev}

    # ---------- pruning ----------
    def prune(self):
        now = time.time()
        for d, ttl in ((self.jobs_dir, PRUNE_AFTER), (self.res_dir, PRUNE_AFTER)):
            for n in os.listdir(d):
                p = os.path.join(d, n)
                try:
                    if now - os.path.getmtime(p) > ttl:
                        os.remove(p)
                except OSError:
                    pass
        for n in os.listdir(self.src_dir):
            p = os.path.join(self.src_dir, n)
            try:
                source = _read_json(p)
                ttl = source.get("ttl", SOURCE_TTL)
                if type(ttl) is not int or ttl < SOURCE_TTL:
                    ttl = SOURCE_TTL
                fetched = source.get("fetched", os.path.getmtime(p))
                if now - fetched > ttl:
                    os.remove(p)
            except (OSError, ValueError, TypeError):
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
        """The cached health plus the history log's path and writability (checked live, cheap, touches nothing)."""
        return dict(self._health_cached(), log_path=historylog.log_path(), log_writable=historylog.is_writable())

    def _health_cached(self):
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
