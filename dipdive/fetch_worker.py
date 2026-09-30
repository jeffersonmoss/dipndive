"""Article fetch worker, run as a subprocess by acquire._fetch_html under a hard wall-clock limit.

Usage: python -m dipdive.fetch_worker <url>
Success: stdout = one JSON line {url, content_type} then the raw (decompressed, capped) body; exit 0.
Failure: last stderr line is JSON {code, message}; exit 3.
SSRF guard: refuses loopback, private, link-local, CGNAT/Tailscale, *.ts.net, .local, metadata
addresses; every redirect is re-validated (max 5). No DNS pinning (plan accepts DNS rebinding).
"""
import http.client
import ipaddress
import json
import os
import socket
import ssl
import sys
import urllib.parse
import zlib

MAX_BYTES = 5 * 1024 * 1024
SOCK_TIMEOUT = 8


class Fail(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def host_ok(host: str):
    h = host.lower().rstrip(".")
    if os.environ.get("DIPDIVE_TEST_ALLOW_LOOPBACK") == "1" and h in ("127.0.0.1", "localhost"):
        return  # test hook for regression tests with a local server; never set in production
    if h.endswith((".ts.net", ".local", ".internal", ".localhost")) or h in ("localhost", "metadata.google.internal"):
        raise Fail("blocked_address", f"host {host} refused")
    try:
        infos = socket.getaddrinfo(h, None)
    except (socket.gaierror, UnicodeError, ValueError, OSError):
        raise Fail("extract_failed", f"cannot resolve {host}")
    cgnat = ipaddress.ip_network("100.64.0.0/10")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if (ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved or ip.is_multicast
                or ip.is_unspecified or (ip.version == 4 and ip in cgnat) or str(ip) == "169.254.169.254"):
            raise Fail("blocked_address", f"{host} resolves to {ip}")


def make_decoder(enc: str, first: bytes):
    if enc == "gzip":
        return zlib.decompressobj(zlib.MAX_WBITS | 16)
    if enc == "deflate":
        zlib_wrapped = len(first) >= 2 and (first[0] & 0x0F) == 8 and ((first[0] << 8) | first[1]) % 31 == 0
        return zlib.decompressobj(zlib.MAX_WBITS if zlib_wrapped else -zlib.MAX_WBITS)
    return None


def fetch(url: str):
    for _ in range(6):
        u = urllib.parse.urlparse(url)
        try:
            port = u.port
        except ValueError:
            raise Fail("extract_failed", "invalid port")
        if u.scheme not in ("http", "https") or not u.hostname:
            raise Fail("not_a_video", "only http(s) URLs are supported")
        if u.username or u.password:
            raise Fail("blocked_address", "credentials in URL refused")
        host_ok(u.hostname)
        cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
        kw = {"context": ssl.create_default_context()} if u.scheme == "https" else {}
        try:
            conn = cls(u.hostname, port, timeout=SOCK_TIMEOUT, **kw)
        except (ValueError, UnicodeError) as e:
            raise Fail("extract_failed", f"bad URL: {e}")
        try:
            path = (u.path or "/") + (("?" + u.query) if u.query else "")
            conn.request("GET", path, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh) DipDive/0.1",
                "Accept": "text/html,application/xhtml+xml", "Accept-Encoding": "gzip, deflate",
                "Accept-Language": "en"})
            r = conn.getresponse()
            if r.status in (301, 302, 303, 307, 308):
                loc = r.getheader("Location")
                if not loc:
                    raise Fail("extract_failed", "redirect without Location")
                url = urllib.parse.urljoin(url, loc)
                continue
            if r.status in (401, 402, 403):
                raise Fail("no_article_text", f"HTTP {r.status} (login, paywall or bot block)")
            if r.status == 429:
                raise Fail("rate_limited", "HTTP 429")
            if r.status >= 400:
                raise Fail("extract_failed", f"HTTP {r.status}")
            enc = (r.getheader("Content-Encoding") or "").lower().strip()
            body = bytearray()
            dec = None
            first = True
            while True:
                chunk = r.read1(65536)
                if not chunk:
                    break
                if first:
                    dec = make_decoder(enc, chunk)
                    first = False
                if dec:
                    data = chunk
                    while data:
                        body += dec.decompress(data, MAX_BYTES + 1 - len(body))
                        if len(body) > MAX_BYTES or (dec.unconsumed_tail and len(body) >= MAX_BYTES):
                            raise Fail("too_long", "article over 5 MB")
                        data = dec.unconsumed_tail
                else:
                    body += chunk
                    if len(body) > MAX_BYTES:
                        raise Fail("too_long", "article over 5 MB")
            return url, r.getheader("Content-Type") or "", bytes(body)
        except (socket.timeout, TimeoutError):
            raise Fail("timeout", "article fetch timed out")
        except zlib.error as e:
            raise Fail("extract_failed", f"bad compressed body: {e}")
        except (OSError, http.client.HTTPException, UnicodeError, ValueError) as e:
            raise Fail("extract_failed", f"{type(e).__name__}: {e}")
        finally:
            conn.close()
    raise Fail("extract_failed", "too many redirects")


def main():
    try:
        url, ctype, body = fetch(sys.argv[1])
    except Fail as e:
        print(json.dumps({"code": e.code, "message": e.message}), file=sys.stderr)
        return 3
    except Exception as e:  # any other input error is still a classified failure
        print(json.dumps({"code": "extract_failed", "message": f"{type(e).__name__}: {e}"}), file=sys.stderr)
        return 3
    sys.stdout.buffer.write(json.dumps({"url": url, "content_type": ctype}).encode() + b"\n" + body)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
