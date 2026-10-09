#!/usr/bin/env python3
"""trace_commands.py —— 从应用端 bundle 里反解出前端真正会调用的 API 命令名。

旧脚本 api_trace.py / emit_contract.py 把模块名写死成 `api-pyi_9PXn.js`，
线上每次重新构建 hash 就变（现在是 `api-DYG_whnY.js`），脚本立刻失效。
本脚本改为**自动识别**：谁持有 `/api/${...}` 的 fetch 实现，谁就是 API 模块。

    python3 tools/trace_commands.py                       # 扫仓库 app/assets
    python3 tools/trace_commands.py --dir .live/app/assets
    python3 tools/trace_commands.py --dir .live/app/assets -o .live/commands.json

为什么必须走「导出别名 → 每 chunk 的 import 别名 → 调用点」这条链：
代码被 minify 过，命令名是**唯一的可靠锚点**，但直接正则扫字符串会混进
大量 DOM 事件名（mousemove / touchstart）和 MIME 类型。只有先确定
「哪个局部别名是 API 包装函数」，再扫 `别名("命令名")` 才干净。
"""
import argparse
import collections
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 直接正则扫字符串时会混进来的噪声
NOISE = {
    "click", "change", "blur", "focus", "load", "message", "connect", "disconnect",
    "canvas", "clipboard", "contextmenu", "paste", "wheel", "resize", "keydown",
    "keyup", "mousedown", "mouseup", "mousemove", "mouseover", "mouseleave",
    "touchstart", "touchend", "touchmove", "touchcancel", "gesturestart",
    "gesturemove", "gestureend", "copy", "cut", "drag", "drop", "scroll", "input",
    "submit", "error", "open", "close", "abort", "online", "offline", "toggle",
    "visibilitychange", "beforeunload", "popstate", "hashchange", "storage",
    "animationend", "transitionend", "select", "reset", "invalid", "waiting",
    "playing", "pause", "ended", "progress", "durationchange", "canplay",
}
CMD_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9]{2,60}$")


def find_api_module(assets):
    """持有 `/api/${...}` fetch 实现的那个 chunk 就是 API 模块。"""
    cands = []
    for fn in sorted(os.listdir(assets)):
        if not fn.endswith(".js"):
            continue
        p = os.path.join(assets, fn)
        try:
            s = open(p, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        if "/api/${" in s and "export" in s:
            score = s.count("/api/${") * 10 + len(s) // 1000
            cands.append((score, fn, len(s)))
    if not cands:
        return None
    cands.sort(reverse=True)
    return cands[0][1]


def export_map(api_src):
    """export{a as B, c as D} -> {exported_alias: local_name}"""
    out = {}
    for m in re.finditer(r"export\s*\{([^}]*)\}", api_src):
        for part in m.group(1).split(","):
            part = part.strip()
            mm = re.match(r"([\w$]+)\s+as\s+([\w$]+)", part)
            if mm:
                out[mm.group(2)] = mm.group(1)
            elif part:
                out[part] = part
    return out


def wrapper_locals(api_src, exports):
    """在 API 模块里找出「真正会打到 /api/ 的局部函数」—— 它们才是命令载体。

    两种形态都要覆盖：

    1. 直接定义
           let l=(e,n)=>fetch(`${t}/api/${e}`,...)      // 原始 fetch
           function ct(e,t,n,r){ ... XMLHttpRequest ... } // 上传
    2. 从 API 客户端工厂解构出来（新构建就是这种）
           var $=Ce({baseUrl:X,...});
           var {apiPost:tt, apiPostAllPages:nt, apiPostBlob:rt,
                apiPostForm:it, openStream:at, authPost:ot, authGet:st}=$;
    """
    locals_ = sorted(set(exports.values()))
    found = set()

    # 形态 1：函数/箭头定义，体内（或紧邻）出现 /api/
    for name in locals_:
        for m in re.finditer(r"(?:function\s+" + re.escape(name) + r"\s*\(|"
                             r"(?:const|let|var)\s+" + re.escape(name) + r"\s*=\s*(?:async\s*)?\(|"
                             r"(?:const|let|var)\s+" + re.escape(name) + r"\s*=\s*(?:async\s*)?function)",
                             api_src):
            tail = api_src[m.start(): m.start() + 900]
            if "/api/" in tail:
                found.add(name)
                break

    # 形态 2：解构赋值，属性名带 api / auth / stream / blob / upload 语义。
    # 注意新构建里它长这样（和 `var $=Ce({...})` 写在同一条 var 语句里）：
    #     var $=Ce({baseUrl:X,...}),{apiPost:tt,apiPostAllPages:nt,...}=$;
    # 所以不能只匹配紧邻 var 的那个 {...}，要在整段源码里找 `{key:local}=绑定`。
    for m in re.finditer(r"\{([^}]{0,800})\}\s*=\s*([\w$]+)\s*[;,]", api_src):
        for part in m.group(1).split(","):
            mm = re.match(r"\s*([\w$]+)\s*:\s*([\w$]+)\s*$", part)
            if not mm:
                continue
            key, local = mm.group(1), mm.group(2)
            if re.match(r"^(api|auth|open|upload)", key, re.I) and local in locals_:
                found.add(local)
    return found


def trace(assets, api_mod):
    api_src = open(os.path.join(assets, api_mod), encoding="utf-8", errors="replace").read()
    exports = export_map(api_src)
    wraps = wrapper_locals(api_src, exports)
    exported_aliases = {a for a, l in exports.items() if l in wraps}
    # 注意：新构建里包装函数的导出别名就是单字符（apiPost→a、authGet→u …），
    # 不能按长度过滤。噪声交给下面的命令名形状规则去挡。
    exported_aliases = {a for a in exported_aliases if not a[0].isdigit()}

    imp_re = re.compile(r"import\s*\{([^}]*)\}\s*from\s*[\"']\./" + re.escape(api_mod) + r"[\"']")
    hits = collections.Counter()
    by_file = collections.defaultdict(set)

    for fn in sorted(os.listdir(assets)):
        if not fn.endswith(".js") or fn == api_mod:
            continue
        p = os.path.join(assets, fn)
        try:
            src = open(p, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        if api_mod not in src:
            continue
        aliases = set()
        for imp in imp_re.findall(src):
            for part in imp.split(","):
                part = part.strip()
                mm = re.match(r"([\w$]+)\s+as\s+([\w$]+)", part)
                if mm and mm.group(1) in exported_aliases:
                    aliases.add(mm.group(2))
                elif part in exported_aliases:
                    aliases.add(part)
        if not aliases:
            continue
        for a in aliases:
            pat = re.compile(re.escape(a) + r"\s*\(\s*[`\"']([^`\"'\n]{2,80})[`\"']")
            for m in pat.finditer(src):
                c = m.group(1)
                if not CMD_RE.match(c) or c.lower() in NOISE or "/" in c or "." in c:
                    continue
                hits[c] += 1
                by_file[fn].add(c)
    return api_src, exports, sorted(wraps), sorted(exported_aliases), hits, by_file


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.join(ROOT, "app", "assets"),
                    help="产物目录（默认仓库 app/assets）")
    ap.add_argument("-o", "--out", default=None, help="输出 JSON 路径")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    assets = args.dir
    api_mod = find_api_module(assets)
    if not api_mod:
        print("在 %s 里没找到 API 模块（没有含 /api/${ 的 chunk）" % assets)
        return 1

    api_src, exports, wraps, aliases, hits, by_file = trace(assets, api_mod)
    cmds = sorted(hits)

    m = re.search(r"api\.clawsgo\.cn", api_src)
    base = None
    if m:
        mm = re.search(r"([\w$]+)\s*=\s*[`\"]https://api\.clawsgo\.cn[`\"]", api_src)
        base = mm.group(1) if mm else None

    if not args.quiet:
        print("API 模块   : %s" % api_mod)
        print("API 常量   : %s" % (base or "未识别"))
        print("包装函数   : %s" % ", ".join(wraps))
        print("导出别名   : %s" % ", ".join(aliases))
        print("命令总数   : %d" % len(cmds))
        for c in cmds:
            print("   %3d  %s" % (hits[c], c))

    out = {
        "assets_dir": assets,
        "api_module": api_mod,
        "api_base_const": base,
        "wrapper_locals": wraps,
        "exported_aliases": aliases,
        "command_count": len(cmds),
        "commands": cmds,
        "commands_with_hits": hits.most_common(),
        "commands_by_file": {k: sorted(v) for k, v in sorted(by_file.items())},
    }
    o = args.out or os.path.join(ROOT, ".live", "commands-traced.json")
    os.makedirs(os.path.dirname(o), exist_ok=True)
    with open(o, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("\n-> %s" % o)
    return 0


if __name__ == "__main__":
    sys.exit(main())
