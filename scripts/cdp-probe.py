#!/usr/bin/env python3
"""CDP 联调探针：连接本机 Chrome 调试端口，导航并读取页面 DOM 结构。

用法:
  python scripts/cdp-probe.py tabs                # 列出 page 标签
  python scripts/cdp-probe.py dump <tabId>        # 输出当前页面结构化 DOM 摘要
  python scripts/cdp-probe.py open <url>          # 新标签打开 URL（返回 tabId）
  python scripts/cdp-probe.py nav <tabId> <url>   # 指定标签导航

输出为 JSON（UTF-8）。只输出技术结构信息，不落任何业务明文。
"""
import asyncio
import json
import sys
import urllib.request

import websockets

CDP_HTTP = "http://127.0.0.1:9222"


def http_json(path):
    with urllib.request.urlopen(CDP_HTTP + path, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))


async def cdp_call(ws_url, method, params=None, timeout=20):
    async with websockets.connect(ws_url, max_size=32 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
            if msg.get("id") == 1:
                return msg.get("result", {})
            if msg.get("method") == "Page.loadEventFired":
                pass  # 继续等待 id=1 的响应


async def evaluate(ws_url, expression, timeout=20):
    res = await cdp_call(ws_url, "Runtime.evaluate",
                         {"expression": expression, "returnByValue": True}, timeout)
    return res.get("result", {}).get("value")


def dom_summary_expr():
    # 返回页面结构化摘要（纯技术信息）
    return """(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      return {
        url: location.href,
        title: document.title,
        inputs: q('input').map(i => ({t: i.type, ph: i.placeholder, id: i.id, cls: (i.className||'').toString().slice(0,40)})),
        buttons: q('button').map(b => ({txt: (b.innerText||'').trim().slice(0,30), cls: (b.className||'').toString().slice(0,40)})),
        clickables: q('[class*="tab" i], [class*="btn" i]').slice(0,15).map(e => ({txt: (e.innerText||'').trim().slice(0,20), cls: (e.className||'').toString().slice(0,50)})),
        imgs: q('img').slice(0,5).map(i => ({src: (i.src||'').slice(0,50), cls: (i.className||'').toString().slice(0,30)})),
        text: document.body.innerText.slice(0, 500)
      };
    })()"""


async def do_tabs():
    tabs = http_json("/json")
    pages = [{"id": t["id"], "title": (t.get("title") or "")[:50], "url": (t.get("url") or "")[:100]}
             for t in tabs if t.get("type") == "page"]
    print(json.dumps(pages, ensure_ascii=False, indent=1))


async def do_dump(tab_id):
    tabs = http_json("/json")
    target = next(t for t in tabs if t.get("id") == tab_id)
    value = await evaluate(target["webSocketDebuggerUrl"], dom_summary_expr())
    print(json.dumps(value, ensure_ascii=False, indent=1))


async def do_open(url):
    # Chrome 126+ 要求 PUT /json/new（GET 返回 405）
    req = urllib.request.Request(CDP_HTTP + "/json/new?" + urllib.parse.quote(url, safe=""), method="PUT")
    with urllib.request.urlopen(req, timeout=5) as r:
        res = json.loads(r.read().decode("utf-8"))
    print(json.dumps({"id": res["id"], "url": res["url"]}, ensure_ascii=False))


def analyze_expr():
    # 结构脱敏分析：用户区/顶栏/列表容器/tab 结构（文本中省份/姓名等真实信息替换为占位）
    return """(() => {
      const leaf = (txt) => [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.innerText||'').includes(txt));
      const redact = (s) => s.replace(/[\\u4e00-\\u9fa5]{2,4}(?=省|市|县|区)/g, '[PROV]').replace(/(省|市|县|区)[\\u4e00-\\u9fa5]{2,4}/g, '$1[NAME]');
      const walk = (el, depth) => {
        const o = { cls: (el.className||'').toString().slice(0,70), tag: el.tagName };
        if (depth > 0 && el.children.length) o.children = [...el.children].slice(0,12).map(c => walk(c, depth-1));
        if (!el.children.length && (el.innerText||'').trim()) o.txt = redact(el.innerText.trim().slice(0,24));
        return o;
      };
      return JSON.stringify({
        url: location.href,
        topUserArea: leaf('省').slice(0,3).map(e => walk(e, 1)),
        header: [...document.querySelectorAll('header, .fd-header, [class*="header" i]')].slice(0,3).map(e => walk(e, 1)),
        tabbar: [...document.querySelectorAll('.fd-com-tab, [class*="com-tab"]')].slice(0,2).map(e => walk(e, 1)),
        listAreas: [...document.querySelectorAll('[class*="list" i], [class*="table" i]')].slice(0,8).map(e => ({cls:(e.className||'').toString().slice(0,70), tag:e.tagName, kids: e.children.length})),
        inputs: [...document.querySelectorAll('input')].map(i => ({cls:(i.className||'').toString().slice(0,50), ph:(i.placeholder||'').slice(0,30)})),
        pagination: [...document.querySelectorAll('[class*="pagination" i]')].slice(0,2).map(e => ({cls:(e.className||'').toString().slice(0,60), txt:redact((e.innerText||'').trim().slice(0,30))}))
      }, null, 1);
    })()"""


async def do_analyze(tab_id):
    tabs = http_json("/json")
    target = next(t for t in tabs if t.get("id") == tab_id)
    value = await evaluate(target["webSocketDebuggerUrl"], analyze_expr())
    print(json.dumps(value, ensure_ascii=False, indent=1))


async def do_click_text(tab_id, text):
    """点击页面中文本完全匹配的叶子元素（联调用，受控点击）。"""
    expr = ("(() => { const els = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 "
            f"&& (e.innerText||'').trim() === {json.dumps(text)}); "
            "if (!els.length) return {ok:false, reason:'not_found'}; els[0].click(); return {ok:true, count:els.length}; })()")
    tabs = http_json("/json")
    target = next(t for t in tabs if t.get("id") == tab_id)
    value = await evaluate(target["webSocketDebuggerUrl"], expr)
    print(json.dumps(value, ensure_ascii=False))


async def do_nav(tab_id, url):
    tabs = http_json("/json")
    target = next(t for t in tabs if t.get("id") == tab_id)
    await cdp_call(target["webSocketDebuggerUrl"], "Page.navigate", {"url": url})
    await asyncio.sleep(4)  # 等待 SPA 渲染
    print(json.dumps({"navigated": True, "tab": tab_id}, ensure_ascii=False))


async def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "tabs"
    if cmd == "tabs":
        await do_tabs()
    elif cmd == "dump":
        await do_dump(sys.argv[2])
    elif cmd == "analyze":
        await do_analyze(sys.argv[2])
    elif cmd == "click":
        await do_click_text(sys.argv[2], sys.argv[3])
    elif cmd == "open":
        await do_open(sys.argv[2])
    elif cmd == "nav":
        await do_nav(sys.argv[2], sys.argv[3])
    else:
        print(json.dumps({"error": f"unknown cmd {cmd}"}))
        sys.exit(2)


if __name__ == "__main__":
    asyncio.run(main())
