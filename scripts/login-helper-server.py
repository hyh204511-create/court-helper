#!/usr/bin/env python3
"""court-helper 的本地账号服务（仅监听 127.0.0.1:8765）。"""

import argparse
import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HOST = "127.0.0.1"
PORT = 8765
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ACCOUNTS = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "accounts.txt"))
MAX_BODY_BYTES = 1024 * 1024
MAX_REJECT_DRAIN_BYTES = 8 * MAX_BODY_BYTES

_OCR_ENGINE = None
_OCR_INITIALIZED = False


def load_accounts(path):
    """读取账号文件；注释/空行跳过，密码保留分隔符后的内部空格。"""
    if not os.path.isfile(path):
        return []

    accounts = []
    try:
        with open(path, "r", encoding="utf-8") as account_file:
            for raw_line in account_file:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                account, separator, password = line.partition(" ")
                if not separator or not account:
                    continue
                password = password.strip()
                if not password:
                    continue
                accounts.append({"account": account, "password": password})
    except (OSError, UnicodeError):
        return []
    return accounts


def recognize(image):
    """调用可选 ddddocr；导入/初始化失败不向客户端暴露内部原因。"""
    global _OCR_ENGINE, _OCR_INITIALIZED
    if not _OCR_INITIALIZED:
        _OCR_INITIALIZED = True
        try:
            import ddddocr

            _OCR_ENGINE = ddddocr.DdddOcr(show_ad=False)
        except Exception:
            _OCR_ENGINE = None
            return None, "DDDDOCR_MISSING"

    if _OCR_ENGINE is None:
        return None, "DDDDOCR_MISSING"

    try:
        image_bytes = base64.b64decode(image, validate=True)
        if not image_bytes:
            return None, "BAD_REQUEST"
        text = _OCR_ENGINE.classification(image_bytes)
        text = str(text).strip()
        if not text:
            return None, "OCR_FAILED"
        return text, None
    except Exception:
        return None, "OCR_FAILED"


class LoginHelperHandler(BaseHTTPRequestHandler):
    accounts_path = DEFAULT_ACCOUNTS

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._json(200, {"ok": True})
            return
        if path == "/accounts":
            self._json(200, {"ok": True, "accounts": load_accounts(self.accounts_path)})
            return
        self._json(404, {"ok": False, "error": "NOT_FOUND"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path != "/ocr":
            self._json(404, {"ok": False, "error": "NOT_FOUND"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            self._json(400, {"ok": False, "error": "BAD_REQUEST"})
            return
        if content_length < 0:
            self._json(400, {"ok": False, "error": "BAD_REQUEST"})
            return
        if content_length > MAX_BODY_BYTES:
            if content_length <= MAX_REJECT_DRAIN_BYTES:
                self.rfile.read(content_length)
            self._json(413, {"ok": False, "error": "REQUEST_TOO_LARGE"})
            return

        try:
            raw_body = self.rfile.read(content_length)
            payload = json.loads(raw_body.decode("utf-8"))
        except Exception:
            self._json(400, {"ok": False, "error": "BAD_REQUEST"})
            return
        if not isinstance(payload, dict) or not isinstance(payload.get("image"), str) or not payload["image"]:
            self._json(400, {"ok": False, "error": "IMAGE_REQUIRED"})
            return

        try:
            base64.b64decode(payload["image"], validate=True)
        except Exception:
            self._json(400, {"ok": False, "error": "BAD_REQUEST"})
            return

        text, error = recognize(payload["image"])
        if error:
            if error == "BAD_REQUEST":
                self._json(400, {"ok": False, "error": error})
            else:
                self._json(200, {"ok": False, "error": error})
            return
        self._json(200, {"ok": True, "text": text})

    def log_message(self, _format, *_args):
        # BaseHTTPRequestHandler 默认会记录请求路径/查询串；本服务不记录访问日志。
        return


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


def main():
    parser = argparse.ArgumentParser(description="court-helper 本地账号服务")
    parser.add_argument("--accounts", default=DEFAULT_ACCOUNTS, help="账号文件路径")
    args = parser.parse_args()

    LoginHelperHandler.accounts_path = os.path.abspath(args.accounts)
    server = ReusableThreadingHTTPServer((HOST, PORT), LoginHelperHandler)
    print(f"[login-helper] listening on {HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
