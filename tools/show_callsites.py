#!/usr/bin/env python3
"""show_callsites.py —— 打印某条（或某批）命令在 bundle 里的真实调用点。

后端契约的唯一权威是**前端调用点**：它传什么参数、怎么解构返回值。
本脚本把调用点连同上下文一起挖出来，省得人工在 800 个 minify 文件里翻。

    python3 tools/show_callsites.py --dir .live/app/assets getCards applyCard
    python3 tools/show_callsites.py --dir .live/app/assets --new      # 全部新增命令
    python3 tools/show_callsites.py --dir .live/app/assets --new -o /tmp/cs.txt
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CTX_BEFORE = 320
CTX_AFTER = 720


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.join(ROOT, "app", "assets"))
    ap.add_argument("commands", nargs="*")
    ap.add_argument("--new", action="store_true",
                    help="对 .live/commands-traced.json 里列出的命令，只显示服务端未注册的")
    ap.add_argument("--registered", default=None, help="服务端已注册命令 JSON（/__commands 的响应）")
    ap.add_argument("-o", "--out", default=None)
    args = ap.parse_args()

    targets = list(args.commands)
    if args.new:
        traced = json.load(open(os.path.join(ROOT, ".live", "commands-traced.json")))
        reg_path = args.registered or os.path.join(ROOT, ".live", "registered.json")
        known = set()
        if os.path.exists(reg_path):
            known = set(json.load(open(reg_path))["commands"])
        targets = [c for c in traced["commands"] if c not in known]

    assets = args.dir
    srcs = {}
    for fn in sorted(os.listdir(assets)):
        if fn.endswith(".js"):
            try:
                srcs[fn] = open(os.path.join(assets, fn), encoding="utf-8", errors="replace").read()
            except OSError:
                pass

    lines = []
    for cmd in targets:
        pat = re.compile(r"[`\"']" + re.escape(cmd) + r"[`\"']")
        found = []
        for fn, s in srcs.items():
            for m in pat.finditer(s):
                a = max(0, m.start() - CTX_BEFORE)
                b = min(len(s), m.end() + CTX_AFTER)
                found.append((fn, s[a:b]))
        lines.append("=" * 78)
        lines.append("COMMAND  %s   (%d 处调用)" % (cmd, len(found)))
        lines.append("=" * 78)
        for fn, snip in found[:4]:
            lines.append("--- %s ---" % fn)
            lines.append(snip.replace("\n", " "))
            lines.append("")

    text = "\n".join(lines)
    if args.out:
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        open(args.out, "w", encoding="utf-8").write(text)
        print("-> %s  (%d 条命令, %d 字符)" % (args.out, len(targets), len(text)))
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
