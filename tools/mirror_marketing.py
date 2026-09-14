#!/usr/bin/env python3
"""Mirror the clawsgo.cn marketing site (5 routes) plus every asset each route needs."""
import os, re, ssl, time, json
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, "site")
ORIGIN = "https://clawsgo.cn"
ROUTES = ["/", "/terms", "/privacy", "/usage-policy", "/billing-terms"]


def get(url, retries=4, timeout=45):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept": "*/*",
                "Accept-Language": "zh-CN,zh;q=0.9",
            })
            with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
                return r.read(), dict(r.headers)
        except Exception as e:
            last = e
            time.sleep(0.5 * (i + 1))
    raise last


def put(rel, data):
    p = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if isinstance(data, str):
        data = data.encode("utf-8")
    with open(p, "wb") as f:
        f.write(data)
    return len(data)


def main():
    pages = {}
    refs = set()
    for route in ROUTES:
        url = ORIGIN + route
        html, hdrs = get(url)
        name = "index.html" if route == "/" else route.strip("/") + ".html"
        put(os.path.join("site", name), html)
        text = html.decode("utf-8", "replace")
        pages[route] = {"file": name, "bytes": len(html), "headers": {k: v for k, v in hdrs.items() if k.lower() in ("x-nextjs-cache", "x-nextjs-prerender", "etag")}}
        for m in re.findall(r'/_(?:next)/[A-Za-z0-9_\-\./%]+', text):
            refs.add(m)
        for m in re.findall(r'src="(/[^"]+\.(?:svg|png|jpg|jpeg|webp|ico|woff2?|json))"', text):
            refs.add(m)
        for m in re.findall(r'href="(/[^"]+\.(?:css|js|png|ico|svg|woff2?|json))"', text):
            refs.add(m)
        # og / icon absolute
        for m in re.findall(r'https://clawsgo\.cn(/[^"\s]+\.(?:png|ico|svg|jpg))', text):
            refs.add(m)

    print(f"total refs: {len(refs)}")
    ok = err = 0
    for r in sorted(refs):
        if r.startswith("/_next/static/"):
            rel = "site" + r
        else:
            rel = "site" + r
        try:
            data, _ = get(ORIGIN + r)
            put(rel, data)
            ok += 1
        except Exception as e:
            err += 1
            print(f"  ERR {r}  {e}")

    # always-grab well-known files
    for extra in ["/favicon.ico", "/apple-icon.png", "/og.png", "/icon.png",
                  "/robots.txt", "/sitemap.xml", "/join-us-poster.jpg",
                  "/manifest.webmanifest", "/version.json"]:
        try:
            data, _ = get(ORIGIN + extra)
            put("site" + extra, data)
            print(f"  OK(well-known) {extra} {len(data)}")
        except Exception as e:
            print(f"  skip {extra}  {e}")

    print(f"\ndownloaded ok={ok} err={err}")
    with open(os.path.join(ROOT, "analysis", "marketing_pages.json"), "w", encoding="utf-8") as f:
        json.dump({"pages": pages, "refs": sorted(refs)}, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
