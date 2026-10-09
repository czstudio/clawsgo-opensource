#!/usr/bin/env python3
"""sync_site.py —— 把 staging（.live/site）同步进仓库的 site/，并施加本地化改写。

    python3 tools/sync_site.py                 # 同步（会打印将要发生的改动）
    python3 tools/sync_site.py --apply         # 真正写盘
    LIVE_DIR=<dir> python3 tools/sync_site.py --apply

做三件事：
  1. 用 staging 覆盖 site/ 的同名文件，新增文件直接拷入
  2. 删除「仓库有、线上已没有」的陈旧 chunk（构建换 hash 后的残留）
  3. 把营销页里的 CTA / 登录链接从线上应用域名改写成本地应用端口

**只改域名常量，HTML 其余字节保持原样** —— 与 assemble.py 的口径一致。
"""
import argparse
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE = os.environ.get("LIVE_DIR") or os.path.join(ROOT, ".live")
STAGE = os.path.join(LIVE, "site")
DEST = os.path.join(ROOT, "site")

LOCAL_APP = os.environ.get("LOCAL_APP_ORIGIN", "http://localhost:5181")
LOCAL_SITE = os.environ.get("LOCAL_SITE_ORIGIN", "http://localhost:5180")

# 只改这两个前缀：CTA / 登录按钮指向的应用域名。
REWRITES = [
    ("https://app.clawsgo.cn", LOCAL_APP),
    ("https://app.clawsgo.ai", LOCAL_APP),
]


def rel_files(base):
    out = set()
    for dp, _dn, fns in os.walk(base):
        for fn in fns:
            out.add(os.path.relpath(os.path.join(dp, fn), base).replace(os.sep, "/"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正写盘；不加则只打印计划")
    args = ap.parse_args()

    if not os.path.isdir(STAGE):
        print("没有找到 staging：%s（先跑 tools/mirror_live.py --only site）" % STAGE)
        return 1

    stage_files = rel_files(STAGE)
    dest_files = rel_files(DEST) if os.path.isdir(DEST) else set()

    to_add = sorted(stage_files - dest_files)
    to_del = sorted(dest_files - stage_files)
    common = sorted(stage_files & dest_files)

    to_update = []
    for rel in common:
        a = os.path.join(STAGE, rel)
        b = os.path.join(DEST, rel)
        if os.path.getsize(a) != os.path.getsize(b) or open(a, "rb").read() != open(b, "rb").read():
            to_update.append(rel)

    print("staging 文件 %d  仓库文件 %d" % (len(stage_files), len(dest_files)))
    print("  新增   %d" % len(to_add))
    print("  更新   %d" % len(to_update))
    print("  删除   %d" % len(to_del))
    if not args.apply:
        print("\n（只打印计划，加 --apply 才写盘）")
        for r in to_add[:20]:
            print("   + " + r)
        for r in to_update[:20]:
            print("   ~ " + r)
        for r in to_del[:20]:
            print("   - " + r)
        return 0

    for rel in to_add + to_update:
        src = os.path.join(STAGE, rel)
        dst = os.path.join(DEST, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if rel.endswith(".html"):
            html = open(src, encoding="utf-8", errors="replace").read()
            for old, new in REWRITES:
                html = html.replace(old, new)
            with open(dst, "w", encoding="utf-8") as f:
                f.write(html)
        else:
            shutil.copyfile(src, dst)

    for rel in to_del:
        os.remove(os.path.join(DEST, rel))
        # 清掉因此变空的目录
        d = os.path.dirname(os.path.join(DEST, rel))
        while d.startswith(DEST) and d != DEST:
            try:
                os.rmdir(d)
            except OSError:
                break
            d = os.path.dirname(d)

    print("\n已写入 %s" % DEST)
    print("  HTML 改写：%s" % "、".join("%s -> %s" % (a, b) for a, b in REWRITES))

    man = {
        "staging": os.path.relpath(STAGE, ROOT),
        "added": to_add, "updated": to_update, "removed": to_del,
        "rewrites": REWRITES,
        "pages": sorted(r for r in rel_files(DEST) if r.endswith("index.html")),
    }
    with open(os.path.join(ROOT, "contracts", "site-sync-manifest.json"), "w", encoding="utf-8") as f:
        json.dump(man, f, ensure_ascii=False, indent=2)
    print("  清单 -> contracts/site-sync-manifest.json（%d 个页面）" % len(man["pages"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
