#!/usr/bin/env python3
"""Mirror clawsgo.cn / app.clawsgo.cn public assets for offline reconstruction."""
import os, re, ssl, sys, time
import urllib.request, urllib.error
from urllib.parse import urljoin, urlparse

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

ROOT = os.path.dirname(os.path.abspath(__file__))


def get(url, timeout=30, retries=3):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "*/*",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            })
            with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
                return r.read(), dict(r.headers)
        except Exception as e:  # noqa
            last = e
            time.sleep(0.6 * (i + 1))
    raise last


def save(rel, data):
    p = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if not isinstance(data, bytes):
        data = data.encode("utf-8")
    with open(p, "wb") as f:
        f.write(data)
    return len(data)


def main():
    queue = []
    # ---- app.clawsgo.cn assets ----
    html, _ = get("https://app.clawsgo.cn/")
    save("app/index.html", html)
    h = html.decode("utf-8", "replace")
    app_assets = sorted(set(re.findall(r'/assets/[A-Za-z0-9_\-\.]+', h)))
    print(f"[app] {len(app_assets)} assets referenced in index.html")
    for a in app_assets:
        queue.append(("app" + a, "https://app.clawsgo.cn" + a))

    downloaded = {}
    for rel, url in queue:
        try:
            data, hdrs = get(url)
            n = save(rel, data)
            downloaded[url] = n
            print(f"  OK  {n:>9}  {rel}")
        except Exception as e:
            print(f"  ERR           {rel}  {e}")

    # ---- harvest further /assets/ refs found inside the main bundle (lazy chunks) ----
    entry = os.path.join(ROOT, "app/assets/index-DGV9-zpZ.js")
    if os.path.exists(entry):
        body = open(entry, encoding="utf-8", errors="replace").read()
        extra = set(re.findall(r'"?/assets/([A-Za-z0-9_\-\.]+\.(?:js|css))"?', body))
        known = {os.path.basename(u) for u in downloaded}
        todo = sorted(extra - known)
        print(f"[lazy] {len(extra)} refs found, {len(todo)} new")
        for name in todo:
            url = "https://app.clawsgo.cn/assets/" + name
            try:
                data, _ = get(url)
                n = save("app/assets/" + name, data)
                print(f"  OK  {n:>9}  {name}")
            except Exception as e:
                print(f"  ERR           {name}  {e}")

    print("done")


if __name__ == "__main__":
    main()
