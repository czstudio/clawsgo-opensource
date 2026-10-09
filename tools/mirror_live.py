#!/usr/bin/env python3
"""mirror_live.py —— 把线上最新版抓到 staging 目录，用来和仓库里的旧快照做 diff。

与 mirror_marketing.py / crawl_app.py 的区别：
  * 那两个脚本直接往 site/ 和 app/ 写，会覆盖仓库现状；
  * 本脚本只写 staging（默认 `<repo>/.live`），绝不碰 site/ 和 app/，
    所以可以随时反复跑，先把「线上改了什么」看清楚再决定要不要同步。

用法：
    python3 tools/mirror_live.py                 # 全量：营销站 + 应用端
    python3 tools/mirror_live.py --only site     # 只抓营销站
    python3 tools/mirror_live.py --only app      # 只抓应用端
    LIVE_DIR=/some/dir python3 tools/mirror_live.py

产物：
    $LIVE_DIR/site/...      营销站（目录路由形态：/download/index.html）
    $LIVE_DIR/app/index.html
    $LIVE_DIR/app/assets/*  应用端全量产物
    $LIVE_DIR/report.json   抓取报告（页数、文件数、入口 bundle、新增文件清单）
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import ssl
import sys
import time
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE = os.environ.get("LIVE_DIR") or os.path.join(ROOT, ".live")

ORIGIN_SITE = os.environ.get("SITE_ORIGIN") or "https://clawsgo.cn"
ORIGIN_APP = os.environ.get("APP_ORIGIN") or "https://app.clawsgo.cn"

# 线上 sitemap 里的路由 + /docs/* 文档站（文档不在 sitemap 里，但都是 200 的预渲染页）。
SITE_ROUTES = [
    # 营销站 / 法律页
    "/", "/download", "/terms", "/privacy", "/usage-policy",
    "/billing-terms", "/promoter-terms",
    # 文档站
    "/docs",
    "/docs/quickstart/sign-up",
    "/docs/quickstart/first-task",
    "/docs/quickstart/choose-model",
    "/docs/quickstart/tour",
    "/docs/guides/files",
    "/docs/guides/desktop",
    "/docs/billing/plans",
    "/docs/billing/credits",
    "/docs/billing/purchase",
    "/docs/faq",
    "/docs/faq/troubleshooting",
]
SITE_WELL_KNOWN = [
    "/favicon.ico", "/apple-icon.png", "/og.png", "/icon.png",
    "/robots.txt", "/sitemap.xml", "/join-us-poster.jpg",
    "/manifest.webmanifest", "/version.json",
]

# 应用端入口里可能出现的引用形态
REF_JS = re.compile(r'''["'`](?:\./)?([A-Za-z0-9_\-\.]+\.(?:js|css|mjs))["'`]''')
REF_ANY = re.compile(r'''["'`](?:\./)?([A-Za-z0-9_\-\.]+\.(?:js|css|mjs|wasm|json|woff2?|ttf|otf|svg|png|webp|jpg|jpeg|gif|map))["'`]''')
ASSET_SRC = re.compile(r'(?:src|href)="(/assets/[^"]+)"')

WORKERS = 8


def get(url, retries=4, timeout=45):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "*/*",
                "Accept-Language": "zh-CN,zh;q=0.9",
            })
            with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.4 * (i + 1))
    raise last


def put(rel, data):
    p = os.path.join(LIVE, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if isinstance(data, str):
        data = data.encode("utf-8")
    with open(p, "wb") as f:
        f.write(data)
    return len(data)


def route_to_file(route):
    """'/download' -> 'site/download/index.html'（与 assemble.py 的目录路由形态一致）"""
    if route in ("/", ""):
        return os.path.join("site", "index.html")
    return os.path.join("site", route.strip("/"), "index.html")


# ------------------------------------------------------------------ marketing

def crawl_marketing():
    print("[site] 抓取营销站 %d 个路由 ..." % len(SITE_ROUTES))
    pages = {}
    refs = set()
    for route in SITE_ROUTES:
        try:
            html = get(ORIGIN_SITE + route)
        except Exception as e:  # noqa: BLE001
            print("  ERR %-18s %s" % (route, e))
            continue
        rel = route_to_file(route)
        n = put(rel, html)
        pages[route] = {"file": rel, "bytes": n}
        print("  OK  %-18s %8d  -> %s" % (route, n, rel))
        text = html.decode("utf-8", "replace")
        for m in re.findall(r'/_(?:next)/[A-Za-z0-9_\-\./%]+', text):
            refs.add(m)
        for m in re.findall(r'(?:src|href)="(/[^"]+\.(?:svg|png|jpg|jpeg|webp|ico|woff2?|css|js|json))"', text):
            refs.add(m)
        for m in re.findall(re.escape(ORIGIN_SITE) + r'(/[^"\s]+\.(?:png|ico|svg|jpg|jpeg|webp|css|js|woff2?))', text):
            refs.add(m)

    for extra in SITE_WELL_KNOWN:
        refs.add(extra)

    print("[site] 下载 %d 个资源 ..." % len(refs))
    ok = err = 0
    with cf.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = {pool.submit(get, ORIGIN_SITE + r): r for r in sorted(refs)}
        for fut in cf.as_completed(futs):
            r = futs[fut]
            try:
                data = fut.result()
            except Exception as e:  # noqa: BLE001
                err += 1
                if "404" not in str(e):
                    print("  ERR %-52s %s" % (r, e))
                continue
            put("site" + r, data)
            ok += 1
    print("[site] 完成 ok=%d err=%d" % (ok, err))
    return {"pages": pages, "assets_ok": ok, "assets_err": err}


# ----------------------------------------------------------------------- app

def crawl_app():
    print("[app] 抓取 %s/ ..." % ORIGIN_APP)
    html = get(ORIGIN_APP + "/")
    put("app/index.html", html)
    text = html.decode("utf-8", "replace")

    entry = None
    m = re.search(r'src="(/assets/index-[A-Za-z0-9_\-]+\.js)"', text)
    if m:
        entry = m.group(1).split("/")[-1]
    print("[app] 入口 bundle: %s" % entry)

    assets_dir = os.path.join(LIVE, "app", "assets")
    os.makedirs(assets_dir, exist_ok=True)

    seeds = set(re.findall(r'/assets/([A-Za-z0-9_\-\.]+)', text))
    if entry:
        seeds.add(entry)

    seen = set(seeds)
    queue = sorted(seeds)
    total = 0
    round_no = 0
    while queue:
        round_no += 1
        batch = [f for f in queue if not os.path.exists(os.path.join(assets_dir, f))]
        queue = []
        if not batch:
            break
        print("[app] round %d: 待下载 %d" % (round_no, len(batch)))
        found_total = 0
        with cf.ThreadPoolExecutor(max_workers=WORKERS) as pool:
            futs = {pool.submit(get, ORIGIN_APP + "/assets/" + name): name for name in batch}
            for fut in cf.as_completed(futs):
                name = futs[fut]
                try:
                    data = fut.result()
                except Exception as e:  # noqa: BLE001
                    print("  ERR %-46s %s" % (name, e))
                    continue
                with open(os.path.join(assets_dir, name), "wb") as f:
                    f.write(data)
                total += 1
                try:
                    body = data.decode("utf-8", "replace")
                except Exception:  # noqa: BLE001
                    continue
                for m in REF_ANY.findall(body):
                    if m not in seen:
                        seen.add(m)
                        queue.append(m)
                        found_total += 1
        print("      +%d new refs" % found_total)
        if not queue:
            break

    files = os.listdir(assets_dir)
    size = sum(os.path.getsize(os.path.join(assets_dir, f)) for f in files)
    print("[app] 完成 files=%d bytes=%d" % (len(files), size))
    return {"entry": entry, "files": len(files), "bytes": size}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["site", "app"], default=None)
    args = ap.parse_args()

    os.makedirs(LIVE, exist_ok=True)
    report = {"origin_site": ORIGIN_SITE, "origin_app": ORIGIN_APP, "dir": LIVE}
    if args.only in (None, "site"):
        report["site"] = crawl_marketing()
    if args.only in (None, "app"):
        report["app"] = crawl_app()
    with open(os.path.join(LIVE, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("\n报告 -> %s" % os.path.join(LIVE, "report.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
