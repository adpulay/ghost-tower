"""POST /score { "text": "..." } -> { "score": 0.97, "brand": "TxTag" }   (INTERFACES.md §8)

    python classifier/server.py [--host 0.0.0.0] [--port 8001] [--model classifier/model/model.joblib]

Stdlib HTTP server (no framework needed on the Brev box). Loads the trained pipeline if it
exists, otherwise serves the rule-based fallback so teammates are never blocked. The active
scorer is reported in the X-Scorer response header and GET /health. CORS is open so the web
app and simulator can call it directly.
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from features import detect_brand, rule_score  # noqa: E402

MAX_TEXT = 2000


class Scorer:
    def __init__(self, model_path: Path | None):
        self.model = None
        self.name = "rules"
        if model_path and model_path.exists():
            import joblib

            self.model = joblib.load(model_path)
            self.name = f"model:{model_path.name}"

    def score(self, text: str) -> dict:
        text = text[:MAX_TEXT]
        if self.model is not None:
            s = float(self.model.predict_proba([text])[0][1])
        else:
            s = rule_score(text)
        return {"score": round(s, 4), "brand": detect_brand(text)}


def make_handler(scorer: Scorer):
    class Handler(BaseHTTPRequestHandler):
        server_version = "GhostTowerScore/1.0"

        def _send(self, code: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("X-Scorer", scorer.name)
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):  # noqa: N802
            self._send(204, {})

        def do_GET(self):  # noqa: N802
            if self.path == "/health":
                return self._send(200, {"ok": True, "scorer": scorer.name})
            self._send(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802
            if self.path != "/score":
                return self._send(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(min(n, 64_000)) or b"{}")
                text = body.get("text")
                if not isinstance(text, str):
                    return self._send(400, {"error": "body must be {\"text\": string}"})
                return self._send(200, scorer.score(text))
            except json.JSONDecodeError:
                return self._send(400, {"error": "invalid JSON"})

        def log_message(self, fmt, *args):
            # Never log message text (privacy); only method/path/status.
            sys.stderr.write(f"{self.address_string()} {self.command} {self.path}\n")

    return Handler


def serve(host: str, port: int, model: Path | None) -> tuple[ThreadingHTTPServer, Scorer]:
    scorer = Scorer(model)
    return ThreadingHTTPServer((host, port), make_handler(scorer)), scorer


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8001)
    ap.add_argument("--model", default=str(HERE / "model" / "model.joblib"))
    a = ap.parse_args()
    httpd, scorer = serve(a.host, a.port, Path(a.model))
    print(f"/score on http://{a.host}:{a.port} using {scorer.name}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
