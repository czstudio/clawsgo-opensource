#!/usr/bin/env python3
"""
assemble.py — turn the raw mirror into a portable, runnable static reproduction.

  * restructures marketing pages into directory routes (site/terms/index.html …)
    so any static file server works with zero rewrite rules
  * repoints the marketing CTA links from the live app host to the local app
  * repoints the app's API base from https://api.clawsgo.cn to same-origin,
    so the bundled mock backend can serve it
"""
import os, re, shutil, sys, json

ROOT = os.environ.get(
    "PROJECT_ROOT",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "clawsgo-opensource"),
)
SITE = os.path.join(ROOT, "site")
APP = os.path.join(ROOT, "app", "assets")

APP_ORIGIN = os.environ.get("LOCAL_APP_ORIGIN", "http://localhost:5181")
changed = []

# ---------------------------------------------------------------- marketing
ROUTES = {
    "index.html": "",
    "terms.html": "terms",
    "privacy.html": "privacy",
    "usage-policy.html": "usage-policy",
    "billing-terms.html": "billing-terms",
}

for src, slug in ROUTES.items():
    p = os.path.join(SITE, src)
    if not os.path.exists(p):
        print(f"  !! missing {src}")
        continue
    html = open(p, encoding="utf-8").read()
    before = html

    # CTA / login links: live app -> local app
    html = html.replace("https://app.clawsgo.cn", APP_ORIGIN)
    html = html.replace("https://app.clawsgo.ai", APP_ORIGIN)

    if slug:
        dst = os.path.join(SITE, slug, "index.html")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "w", encoding="utf-8") as f:
            f.write(html)
        os.remove(p)
        changed.append(f"site/{slug}/index.html")
    else:
        with open(p, "w", encoding="utf-8") as f:
            f.write(html)
        changed.append("site/index.html")

    if html != before:
        print(f"  rewrote links in {src}")

# ---------------------------------------------------------------- app runtime
# api-pyi_9PXn.js holds the single API-base constant.
target = os.path.join(APP, "api-pyi_9PXn.js")
if os.path.exists(target):
    s = open(target, encoding="utf-8").read()
    orig = s
    # W = `https://api.clawsgo.cn`  ->  W = ``   (=> fetch(`/api/<cmd>`) same-origin)
    s2 = re.sub(r"(\bW\s*=\s*)`https://api\.clawsgo\.cn`", r'\1""', s)
    if s2 == s:
        # fall back: any occurrence of the literal
        s2 = s.replace("`https://api.clawsgo.cn`", '""')
    open(target, "w", encoding="utf-8").write(s2)
    print(f"  api base rewritten: {s2 != orig}")
    changed.append("app/assets/api-pyi_9PXn.js")

# marketing host used by the app for outbound links -> local site
target2 = os.path.join(APP, "api-pyi_9PXn.js")
if os.path.exists(target2):
    s = open(target2, encoding="utf-8").read()
    s = s.replace("`https://clawsgo.cn`", f'"{os.environ.get("LOCAL_SITE_ORIGIN", "http://localhost:5180")}"')
    open(target2, "w", encoding="utf-8").write(s)

# ---------------------------------------------------------------- manifest
man = {
    "app_origin": APP_ORIGIN,
    "site_origin": os.environ.get("LOCAL_SITE_ORIGIN", "http://localhost:5180"),
    "marketing_routes": [f"/{s}" if s else "/" for s in ROUTES.values()],
    "app_assets": len([f for f in os.listdir(APP)]),
    "changed": changed,
}
with open(os.path.join(ROOT, "contracts", "mirror-manifest.json"), "w", encoding="utf-8") as f:
    json.dump(man, f, ensure_ascii=False, indent=2)

print(json.dumps(man, ensure_ascii=False, indent=2))
