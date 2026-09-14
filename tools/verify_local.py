#!/usr/bin/env python3
"""Verify the local reproduction: every referenced asset must resolve 200."""
import os, re, sys, ssl, json, urllib.request

CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def head(url):
    try:
        req = urllib.request.Request(url, method="GET", headers={"User-Agent": "verify/1.0"})
        with urllib.request.urlopen(req, timeout=15, context=CTX) as r:
            return r.status, len(r.read())
    except urllib.error.HTTPError as e:
        return e.code, 0
    except Exception as e:
        return 0, 0


def main():
    site = "http://localhost:5180"
    app = "http://localhost:5181"
    problems = []

    pages = ["/", "/terms", "/privacy", "/usage-policy", "/billing-terms"]
    print("### 营销站页面")
    for p in pages:
        st, n = head(site + p)
        flag = "OK " if st == 200 and n > 1000 else "FAIL"
        print(f"  {flag} {p:16} {st} {n}B")
        if flag == "FAIL":
            problems.append(f"{p} -> {st}")

    print("\n### 营销站依赖资源")
    refs = set()
    for p in pages:
        path = os.path.join(ROOT, "site", p.strip("/"), "index.html") if p != "/" else os.path.join(ROOT, "site", "index.html")
        html = open(path, encoding="utf-8", errors="replace").read()
        for m in re.findall(r'/_next/[A-Za-z0-9_\-\./%]+', html):
            refs.add(m)
        for m in re.findall(r'(?:src|href)="(/(?:logos|[/\w\-\.])[^"]*\.(?:svg|png|jpg|jpeg|webp|ico))"', html):
            refs.add(m)
    bad = 0
    for r in sorted(refs):
        st, n = head(site + r)
        if st != 200:
            print(f"  FAIL {r} -> {st}")
            problems.append(f"site{r} -> {st}")
            bad += 1
    print(f"  {len(refs) - bad}/{len(refs)} 可解析")

    print("\n### 应用端")
    st, n = head(app + "/")
    print(f"  {'OK ' if st == 200 else 'FAIL'} app shell  {st} {n}B")

    entry = os.path.join(ROOT, "app", "assets", "index-DGV9-zpZ.js")
    refs2 = set(re.findall(r'["\'`]\./([A-Za-z0-9_\-\.]+\.js)["\'`]', open(entry, encoding="utf-8", errors="replace").read()))
    bad2 = 0
    for r in sorted(refs2):
        st, _ = head(f"{app}/assets/{r}")
        if st != 200:
            print(f"  FAIL /assets/{r} -> {st}")
            problems.append(f"app/assets/{r} -> {st}")
            bad2 += 1
    print(f"  路由 chunk {len(refs2) - bad2}/{len(refs2)} 可解析")

    print("\n### mock API")
    import urllib.request as ur
    for cmd in ["getProfile", "getHosts", "getSkills", "getSubscription", "getTickets", "adminGetAuditLogs"]:
        body = json.dumps({"data": {}}).encode()
        req = ur.Request(f"{app}/api/{cmd}", data=body, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with ur.urlopen(req, timeout=10, context=CTX) as r:
                n = len(r.read())
            print(f"  OK   {cmd:22} 200 {n}B")
        except Exception as e:
            print(f"  FAIL {cmd:22} {e}")
            problems.append(f"api {cmd}")

    print("\n" + ("=" * 50))
    if problems:
        print(f"发现 {len(problems)} 个问题：")
        for p in problems:
            print("  -", p)
        sys.exit(1)
    print("全部通过 ✅")


if __name__ == "__main__":
    main()
