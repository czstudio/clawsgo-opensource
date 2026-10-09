#!/usr/bin/env python3
"""sync_app.py —— 把 staging（.live/app）同步进仓库的 app/，并施加本地化改写。

    python3 tools/sync_app.py                 # 只打印计划
    python3 tools/sync_app.py --apply         # 真正写盘
    LIVE_DIR=<dir> python3 tools/sync_app.py --apply

做四件事：
  1. 用 staging 覆盖 app/index.html 与 app/assets/*（新增直接拷入）
  2. 删除「仓库有、线上已没有」的陈旧 chunk —— 重新构建后旧 hash 文件不会再被引用
  3. 把 API 基址常量改写成同源（这是前端唯一允许改的地方）
  4. 把应用里指向营销站的常量改成本地营销站端口

第 3 步的写法是**自动识别**的：旧构建是 `var W = <api.clawsgo.cn>`，
新构建换成了 `var X = ...`，写死名字每次都要改。这里按「谁后面跟着
api.clawsgo.cn 这个字面量」来定位，构建再变也不会失效。
"""
import argparse
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE = os.environ.get("LIVE_DIR") or os.path.join(ROOT, ".live")
STAGE = os.path.join(LIVE, "app")
DEST = os.path.join(ROOT, "app")
STAGE_ASSETS = os.path.join(STAGE, "assets")
DEST_ASSETS = os.path.join(DEST, "assets")

LOCAL_SITE = os.environ.get("LOCAL_SITE_ORIGIN", "http://localhost:5180")
LOCAL_APP = os.environ.get("LOCAL_APP_ORIGIN", "http://localhost:5181")

API_BASE_RX = re.compile(r"([\w$]+)\s*=\s*[`'\"]https://api\.clawsgo\.(?:cn|ai)[`'\"]")
SITE_BASE_RX = re.compile(r"([\w$]+)\s*=\s*[`'\"]https://clawsgo\.(?:cn|ai)[`'\"]")
# region 表里还有一对出站链接常量（region-*.js），不改的话「官网 / 打开应用」会跳到线上
REGION_SITE_RX = re.compile(r"(siteUrl\s*:\s*)[`'\"]https://clawsgo\.(?:cn|ai)[`'\"]")
REGION_APP_RX = re.compile(r"(appUrl\s*:\s*)[`'\"]https://app\.clawsgo\.(?:cn|ai)[`'\"]")


def rel_files(base):
    out = set()
    for dp, _dn, fns in os.walk(base):
        for fn in fns:
            out.add(os.path.relpath(os.path.join(dp, fn), base).replace(os.sep, "/"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(STAGE_ASSETS):
        print("没有找到 staging：%s（先跑 tools/mirror_live.py --only app）" % STAGE_ASSETS)
        return 1

    stage = rel_files(STAGE_ASSETS)
    dest = rel_files(DEST_ASSETS) if os.path.isdir(DEST_ASSETS) else set()
    to_add = sorted(stage - dest)
    to_del = sorted(dest - stage)
    to_upd = []
    for rel in sorted(stage & dest):
        a = os.path.join(STAGE_ASSETS, rel)
        b = os.path.join(DEST_ASSETS, rel)
        if os.path.getsize(a) != os.path.getsize(b) or open(a, "rb").read() != open(b, "rb").read():
            to_upd.append(rel)

    print("staging assets %d  仓库 assets %d" % (len(stage), len(dest)))
    print("  新增 %d   更新 %d   删除 %d" % (len(to_add), len(to_upd), len(to_del)))
    if not args.apply:
        print("\n（只打印计划，加 --apply 才写盘）")
        return 0

    for rel in to_add + to_upd:
        src = os.path.join(STAGE_ASSETS, rel)
        dst = os.path.join(DEST_ASSETS, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)

    # 旧 chunk 不直接删，挪到 .live/old-assets/ 下：
    # 一是构建产物误删很难恢复，二是某些环境（CI / 受管沙箱）禁止直接 unlink。
    trash = os.path.join(LIVE, "old-assets")
    moved = 0
    for rel in to_del:
        os.makedirs(trash, exist_ok=True)
        src = os.path.join(DEST_ASSETS, rel)
        dst = os.path.join(trash, rel.replace("/", "__"))
        try:
            os.replace(src, dst)
            moved += 1
        except OSError as e:
            print("  跳过 %s：%s" % (rel, e))
    print("  旧 chunk 已移到 %s（%d 个）" % (trash, moved))

    # index.html
    src_html = os.path.join(STAGE, "index.html")
    if os.path.exists(src_html):
        shutil.copyfile(src_html, os.path.join(DEST, "index.html"))

    # ---- 常量改写：只改 API 基址与营销站基址 ----
    rewritten = []
    api_mod = None
    api_mod_candidate = None
    for fn in sorted(os.listdir(DEST_ASSETS)):
        if not fn.endswith(".js"):
            continue
        p = os.path.join(DEST_ASSETS, fn)
        try:
            s = open(p, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        orig = s
        if "/api/${" in s:
            api_mod_candidate = fn
        s2 = API_BASE_RX.sub(lambda m: f'{m.group(1)}=""', s)
        s2 = SITE_BASE_RX.sub(lambda m: f'{m.group(1)}="{LOCAL_SITE}"', s2)
        s2 = REGION_SITE_RX.sub(lambda m: f'{m.group(1)}"{LOCAL_SITE}"', s2)
        s2 = REGION_APP_RX.sub(lambda m: f'{m.group(1)}"{LOCAL_APP}"', s2)
        if s2 != orig:
            open(p, "w", encoding="utf-8").write(s2)
            rewritten.append(fn)
            if api_mod_candidate:
                api_mod = api_mod_candidate

    print("\n已写入 %s" % DEST)
    print("  index.html        -> %s" % os.path.join(DEST, "index.html"))
    print("  API 基址改写      -> %s" % (api_mod or "（未找到，需检查！）"))

    man = {
        "staging": os.path.relpath(STAGE, ROOT),
        "added": len(to_add),
        "updated": len(to_upd),
        "removed": len(to_del),
        "total_assets": len(rel_files(DEST_ASSETS)),
        "rewritten_files": rewritten,
        "local_site_origin": LOCAL_SITE,
    }
    with open(os.path.join(ROOT, "contracts", "app-sync-manifest.json"), "w", encoding="utf-8") as f:
        json.dump(man, f, ensure_ascii=False, indent=2)
    print("  清单 -> contracts/app-sync-manifest.json（assets 共 %d）" % man["total_assets"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
