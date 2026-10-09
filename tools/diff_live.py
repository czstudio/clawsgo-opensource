#!/usr/bin/env python3
"""diff_live.py —— 拿 staging（.live/）和仓库现状做逐文件比对，回答「线上到底改了什么」。

    python3 tools/diff_live.py             # 全量
    python3 tools/diff_live.py --only site
    python3 tools/diff_live.py --only app
    LIVE_DIR=<dir> python3 tools/diff_live.py

判定口径：
    new      —— 线上有、仓库没有
    changed  —— 两边都有但字节不同（含 hash 文件名相同却内容不同的情况）
    removed  —— 仓库有、线上没有（构建产物换 hash 时这是正常的旧文件）
    same     —— 字节一致

产物：$LIVE_DIR/diff.json + 控制台摘要
"""
import argparse
import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE = os.environ.get("LIVE_DIR") or os.path.join(ROOT, ".live")

TARGETS = {
    "site": ("site", os.path.join("site")),
    "app": ("app", os.path.join("app")),
}


def walk(base):
    out = {}
    for dirpath, _dirnames, filenames in os.walk(base):
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            rel = os.path.relpath(p, base).replace(os.sep, "/")
            try:
                with open(p, "rb") as f:
                    out[rel] = hashlib.md5(f.read()).hexdigest()
            except OSError:
                pass
    return out


def scan(root, target):
    """只看真实站点文件，跳过 .live / node_modules 之类"""
    base = os.path.join(root, target)
    if not os.path.isdir(base):
        return {}
    return walk(base)


def diff_one(target, subdir):
    live_base = os.path.join(LIVE, subdir)
    repo_base = os.path.join(ROOT, subdir)
    live = walk(live_base) if os.path.isdir(live_base) else {}
    repo = scan(ROOT, subdir)

    new = sorted(set(live) - set(repo))
    removed = sorted(set(repo) - set(live))
    changed = sorted(k for k in (set(live) & set(repo)) if live[k] != repo[k])
    same = sorted(k for k in (set(live) & set(repo)) if live[k] == repo[k])
    return {"live_files": len(live), "repo_files": len(repo),
            "new": new, "changed": changed, "removed": removed, "same": same}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["site", "app"], default=None)
    ap.add_argument("--limit", type=int, default=40)
    args = ap.parse_args()

    keys = [args.only] if args.only else ["site", "app"]
    report = {}
    for k in keys:
        subdir = TARGETS[k][1]
        d = diff_one(k, subdir)
        report[k] = d
        print("=" * 68)
        print("%s  线上 %d 个文件 / 仓库 %d 个文件" % (k.upper(), d["live_files"], d["repo_files"]))
        print("  新增    %d" % len(d["new"]))
        print("  变更    %d" % len(d["changed"]))
        print("  仅仓库有 %d" % len(d["removed"]))
        print("  一致    %d" % len(d["same"]))
        for label, items in (("新增", d["new"]), ("变更", d["changed"])):
            if items:
                print("  --- %s（前 %d）---" % (label, args.limit))
                for it in items[:args.limit]:
                    print("      " + it)
                if len(items) > args.limit:
                    print("      ... 还有 %d 个" % (len(items) - args.limit))

    with open(os.path.join(LIVE, "diff.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("\n明细 -> %s" % os.path.join(LIVE, "diff.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
