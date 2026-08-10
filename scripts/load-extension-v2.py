#!/usr/bin/env python3
"""验收辅助：CDP 给 chrome://extensions 的 file input 直接设置目录（穿透 shadow DOM）。

用法: python scripts/load-extension-v2.py <tabId> <extensionDir>
"""
import asyncio
import json
import sys

import websockets

CDP_HTTP = "http://127.0.0.1:9222"


def http_json(path):
    import urllib.request
    with urllib.request.urlopen(CDP_HTTP + path, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))


async def main():
    tab_id, ext_dir = sys.argv[1], sys.argv[2]
    tabs = http_json("/json")
    target = next(t for t in tabs if t.get("id") == tab_id)
    ws_url = target["webSocketDebuggerUrl"]

    async with websockets.connect(ws_url, max_size=16 * 1024 * 1024) as ws:
        msg_id = 0

        async def cmd(method, params=None):
            nonlocal msg_id
            msg_id += 1
            await ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
            while True:
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
                if resp.get("id") == msg_id:
                    return resp

        # 开启开发者模式
        await cmd("Runtime.evaluate", {"expression": "(() => { const t = document.querySelector('extensions-manager').shadowRoot.querySelector('#devMode'); if (t && !t.checked) t.click(); return t ? t.checked : false; })()", "returnByValue": True})
        await asyncio.sleep(1.5)

        # 点击加载已解压（创建 file input 并触发对话框）
        click_expr = (
            "(() => { const find = (root) => { for (const el of root.querySelectorAll('*')) { "
            "if (el.id === 'loadUnpacked' || el.id === 'load-unpacked') return el; "
            "if (el.shadowRoot) { const r = find(el.shadowRoot); if (r) return r; } } return null; }; "
            "const b = find(document.querySelector('extensions-manager').shadowRoot); "
            "if (b) { b.click(); return true; } return false; })()"
        )
        await cmd("Runtime.evaluate", {"expression": click_expr, "returnByValue": True})
        await asyncio.sleep(1.5)

        # 找到 file input（穿透 shadow），返回 objectId
        find_expr = (
            "(() => { const find = (root) => { for (const el of root.querySelectorAll('*')) { "
            "if (el.tagName === 'INPUT' && el.type === 'file') return el; "
            "if (el.shadowRoot) { const r = find(el.shadowRoot); if (r) return r; } } return null; }; "
            "const inp = find(document.querySelector('extensions-manager').shadowRoot); "
            "return inp; })()"
        )
        r = await cmd("Runtime.evaluate", {"expression": find_expr, "returnByValue": False})
        obj = r.get("result", {}).get("result", {})
        if obj.get("type") != "object" or not obj.get("objectId"):
            print("ERROR: file input not found", json.dumps(obj)[:200])
            return
        print("file input objectId:", obj["objectId"][:20], "…")

        # 直接设置目录
        r2 = await cmd("DOM.setFileInputFiles", {"files": [ext_dir], "objectId": obj["objectId"]})
        if "error" in r2:
            print("ERROR setFileInputFiles:", r2["error"])
            return
        print("files set OK")

        # 等待扩展出现
        for _ in range(20):
            await asyncio.sleep(1)
            r3 = await cmd("Runtime.evaluate", {"expression": "(() => { const mgr = document.querySelector('extensions-manager'); const items = [...mgr.shadowRoot.querySelectorAll('extensions-item')]; return items.map(i => ({name: i.name || '', id: i.id || ''})); })()", "returnByValue": True})
            items = r3.get("result", {}).get("result", {}).get("value", [])
            if items:
                print("EXTENSIONS:", json.dumps(items, ensure_ascii=False))
                return
        print("ERROR: extension not visible")


asyncio.run(main())
