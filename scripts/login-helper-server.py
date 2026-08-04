#!/usr/bin/env python3
"""login-helper-server.py — court-helper 本地账号与验证码识别服务（仅监听 127.0.0.1）

契约见 docs/specs/login-module.md §6：
  GET  /health    -> {"ok": true}
  GET  /accounts  -> {"ok": true, "accounts": [{"account": "...", "password": "..."}, ...]}
  POST /ocr       -> {"ok": true, "text": "..."} | {"ok": false, "error": "DDDDOCR_MISSING"}

安全约束：
- 只绑定 127.0.0.1；凭据仅经本机回环传输。
- 不打印请求体/凭据；访问日志仅一行摘要（路径不含凭据）。
- accounts.txt 由调用方确保在 .gitignore（仓库已配）。

启动：python scripts/login-helper-server.py [--port 8765] [--accounts <path>]
"""
import argparse
import base64
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def load_accounts(path):
    """解析账号文件：每行 `账号 密码`（首个空白分隔，密码可含空格）；# 注释与空行跳过。"""
    if not os.path.isfile(path):
        return []
    accounts = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            account, sep, password = line.partition(" ")
            account = account.strip()
            password = password.strip()
            if account:
                accounts.append({"account": account, "password": password})
    return accounts


_OCR = None


def recognize(image_b64):
    """ddddocr 识别（可选依赖，懒加载）。返回 (text, error)；error 非 None 表示失败。"""
    global _OCR
    if _OCR is None:
        try:
            import ddddocr

            _OCR = ddddocr.DdddOcr(show_ad=False)
        except Exception:
            return None, "DDDDOCR_MISSING"
    try:
        data = base64.b64decode(image_b64)
        return _OCR.classification(data), None
    except Exception as e:  # noqa: BLE001 —— 识别失败统一返回错误，不让服务崩溃
        return None, f"OCR_FAILED: {e}"


class Handler(BaseHTTPRequestHandler):
    server_version = "LoginHelper/0.1"
    accounts_path = None

    # —— CORS：content script fetch 是从平台页面跨域到 127.0.0.1，必须放行 ——
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
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
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw or b"{}")
            image = payload.get("image", "")
            if not image:
                self._json(400, {"ok": False, "error": "IMAGE_REQUIRED"})
                return
            text, err = recognize(image)
            if err:
                self._json(200, {"ok": False, "error": err})
                return
            self._json(200, {"ok": True, "text": text})
        except Exception as e:  # noqa: BLE001
            self._json(400, {"ok": False, "error": f"BAD_REQUEST: {e}"})

    def log_message(self, fmt, *args):
        # 仅一行访问摘要（路径不含凭据；请求体不打印）
        sys.stderr.write("[login-helper] %s\n" % (fmt % args))


def main():
    ap = argparse.ArgumentParser(description="court-helper 本地账号/验证码识别服务（仅 127.0.0.1）")
    ap.add_argument("--port", type=int, default=8765)
    default_accounts = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "accounts.txt")
    ap.add_argument("--accounts", default=default_accounts)
    args = ap.parse_args()

    Handler.accounts_path = os.path.abspath(args.accounts)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(
        f"[login-helper] listening on http://127.0.0.1:{args.port} (accounts: {Handler.accounts_path})",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
