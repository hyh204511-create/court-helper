#!/usr/bin/env python3
"""验收辅助：CDP 加载 unpacked 扩展（开发者模式 + 文件选择器拦截）。

用法: python scripts/load-extension.py <tabId> <extensionDir>
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

        # 开启开发者模式（点击 #devMode toggle）
        await cmd("Runtime.evaluate", {"expression": "(() => { const t = document.querySelector('extensions-manager').shadowRoot.querySelector('#devMode'); if (t && !t.checked) t.click(); return t ? t.checked : false; })()", "returnByValue": True})
        await asyncio.sleep(1.5)

        # 拦截文件选择器
        await cmd("Page.enable")
        await cmd("Page.setInterceptFileChooserDialog", {"enabled": True})

        # 点击加载已解压（递归穿透 shadow DOM）
        click_expr = (
            "(() => { const find = (root) => { for (const el of root.querySelectorAll('*')) { "
            "if (el.id === 'loadUnpacked' || el.id === 'load-unpacked') return el; "
            "if (el.shadowRoot) { const r = find(el.shadowRoot); if (r) return r; } } return null; }; "
            "const b = find(document.querySelector('extensions-manager').shadowRoot); "
            "if (b) { b.click(); return true; } return false; })()"
        )
        click = await cmd("Runtime.evaluate", {"expression": click_expr, "returnByValue": True})
        print("loadUnpacked clicked:", click.get("result", {}).get("result", {}).get("value"))

        # 等待 fileChooserOpened 事件
        for _ in range(10):
            try:
                evt = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
            except asyncio.TimeoutError:
                print("ERROR: no file chooser event")
                return
            if evt.get("method") == "Page.fileChooserOpened":
                backend = evt["params"]["backendNodeId"]
                await cmd("DOM.setFileInputFiles", {"files": [ext_dir], "backendNodeId": backend})
                print("file set:", ext_dir)
                break
        else:
            print("ERROR: file chooser not opened")
            return

        # 等待扩展加载完成（轮询 extensions-item）
        for _ in range(20):
            await asyncio.sleep(1)
            r = await cmd("Runtime.evaluate", {"expression": "(() => { const mgr = document.querySelector('extensions-manager'); const items = [...mgr.shadowRoot.querySelectorAll('extensions-item')]; return items.map(i => ({name: i.name || '', id: i.id || ''})); })()", "returnByValue": True})
            items = r.get("result", {}).get("result", {}).get("value", [])
            if items:
                print("EXTENSIONS:", json.dumps(items, ensure_ascii=False))
                return
        print("ERROR: extension not visible in list")


asyncio.run(main())
