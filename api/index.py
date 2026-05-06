"""Vercel Python entry: BaseHTTPRequestHandler + ASGI wrapper.
Vercel python builder가 ASGI app 자동 인식 안 함. handler class 패턴은 인식.
import 실패 시 진단 정보 노출.
"""
import sys
import traceback
from pathlib import Path
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, str(Path(__file__).resolve().parent))

_asgi_app = None
_import_error = None

try:
    from server import app as _asgi_app  # noqa: E402
except Exception as e:
    _import_error = f"{type(e).__name__}: {e}\n\n{traceback.format_exc()}"


class handler(BaseHTTPRequestHandler):
    def log_message(self, *a, **kw):
        pass

    def _diagnostic_response(self):
        body = (_import_error or "unknown").encode("utf-8", errors="replace")
        self.send_response(503)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve(self, method: str):
        if _asgi_app is None:
            self._diagnostic_response()
            return

        import asyncio
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length > 0 else b""

        if "?" in self.path:
            raw_path, query = self.path.split("?", 1)
        else:
            raw_path, query = self.path, ""

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": method,
            "scheme": "https",
            "path": raw_path,
            "raw_path": raw_path.encode(),
            "query_string": query.encode(),
            "root_path": "",
            "headers": [
                (k.lower().encode(), v.encode())
                for k, v in self.headers.items()
            ],
            "server": ("vercel", 443),
            "client": ("0.0.0.0", 0),
        }

        result = {"status": 500, "headers": [], "body": bytearray()}
        sent = [False]

        async def receive():
            if not sent[0]:
                sent[0] = True
                return {"type": "http.request", "body": body, "more_body": False}
            return {"type": "http.disconnect"}

        async def send(msg):
            t = msg.get("type")
            if t == "http.response.start":
                result["status"] = msg["status"]
                result["headers"] = msg.get("headers", [])
            elif t == "http.response.body":
                result["body"].extend(msg.get("body", b""))

        async def runner():
            await _asgi_app(scope, receive, send)

        try:
            asyncio.run(runner())
        except Exception as e:
            err = f"ASGI runtime error: {type(e).__name__}: {e}\n\n{traceback.format_exc()}"
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(err.encode("utf-8", errors="replace"))
            return

        self.send_response(result["status"])
        has_ct = False
        for k, v in result["headers"]:
            try:
                ks = k.decode() if isinstance(k, bytes) else k
                vs = v.decode() if isinstance(v, bytes) else v
                if ks.lower() == "content-type":
                    has_ct = True
                self.send_header(ks, vs)
            except Exception:
                pass
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(bytes(result["body"]))

    def do_GET(self):    self._serve("GET")
    def do_POST(self):   self._serve("POST")
    def do_PUT(self):    self._serve("PUT")
    def do_DELETE(self): self._serve("DELETE")
    def do_PATCH(self):  self._serve("PATCH")
    def do_HEAD(self):   self._serve("HEAD")
    def do_OPTIONS(self):self._serve("OPTIONS")
