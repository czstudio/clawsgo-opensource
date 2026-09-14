#!/usr/bin/env python3
"""Recursively pull every chunk under app.clawsgo.cn/assets/ by following
static-import and dynamic-import references from the entry bundle."""
import os, re, ssl, time
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
ROOT = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(ROOT, "app", "assets")
BASE = "https://app.clawsgo.cn/assets/"


def get(url, retries=4, timeout=40):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
                return r.read()
        except Exception as e:
            last = e
            time.sleep(0.5 * (i + 1))
    raise last


REF = re.compile(r'''["'`](?:\./)?([A-Za-z0-9_\-\.]+\.(?:js|css))["'`]''')

seen = set()
queue = []


def seed():
    for f in os.listdir(DIR):
        queue.append(f)
        seen.add(f)
    # entry references
    entry = os.path.join(DIR, "index-DGV9-zpZ.js")
    if os.path.exists(entry):
        s = open(entry, encoding="utf-8", errors="replace").read()
        for m in REF.findall(s):
            if m not in seen:
                seen.add(m)
                queue.append(m)


def main():
    seed()
    round_no = 0
    while queue:
        round_no += 1
        batch = [c for c in queue if not os.path.exists(os.path.join(DIR, c))]
        queue.clear()
        print(f"--- round {round_no}: {len(queue)} queued, {len(batch)} to fetch ---")
        if not batch:
            break
        for name in batch:
            url = BASE + name
            try:
                data = get(url)
                with open(os.path.join(DIR, name), "wb") as f:
                    f.write(data)
                text = data.decode("utf-8", "replace")
                found = 0
                for m in REF.findall(text):
                    if m not in seen:
                        seen.add(m)
                        queue.append(m)
                        found += 1
                print(f"  OK  {len(data):>9}  {name}   (+{found} new refs)")
            except Exception as e:
                print(f"  ERR           {name}   {e}")
    total = sum(os.path.getsize(os.path.join(DIR, f)) for f in os.listdir(DIR))
    print(f"\nfiles={len(os.listdir(DIR))}  bytes={total}")


if __name__ == "__main__":
    main()
