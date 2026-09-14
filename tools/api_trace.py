#!/usr/bin/env python3
"""Trace the exported API-call function from api-pyi_9PXn.js through each chunk's
import alias, then harvest every string literal passed as the command name.

Contract recovered from the bundle:
    const W = 'https://api.clawsgo.cn'
    POST `${W}/api/${cmd}`   body {"data": <payload>}
    -> {"data": ...} | {"error":{"code","message"}}
    resp header `set-auth-token` rotates localStorage 'clawsgo_token'
    POST `${W}/api/auth/${cmd}`
"""
import os, re, json, collections

ROOT = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(ROOT, "app", "assets")
API_MOD = "api-pyi_9PXn.js"

api_src = open(os.path.join(APP, API_MOD), encoding="utf-8", errors="replace").read()

# 1. export map in api module
m = re.search(r"export\s*\{([^}]*)\}", api_src)
exports = {}
if m:
    for part in m.group(1).split(","):
        part = part.strip()
        mm = re.match(r"([\w$]+)\s+as\s+([\w$]+)", part)
        if mm:
            exports[mm.group(2)] = mm.group(1)
        elif part:
            exports[part] = part

# 2. locate the POST /api/${...} wrappers -> those local fn names carry commands
#    Q = json wrapper, _e = blob wrapper, ve = raw-body wrapper, ge = paginate
WRAPPERS = set()
for name in ("Q", "_e", "ve", "ge"):
    if re.search(r"function\s+" + name + r"\b", api_src):
        WRAPPERS.add(name)

# also capture arrow-assigned ones: const x = async(e,t)=> ... `/api/${e}`
for mm in re.finditer(r"/api/\$\{e\}", api_src):
    seg = api_src[max(0, mm.start() - 400):mm.start()]
    fn = re.findall(r"(?:async\s+)?function\s+([\w$]+)\s*\(", seg)
    if fn:
        WRAPPERS.add(fn[-1])

print("wrapper fns in api module:", WRAPPERS)
exported_wrappers = {alias for alias, local in exports.items() if local in WRAPPERS}
print("exported aliases:", exported_wrappers)

# 3. per-chunk: resolve import alias -> wrapper alias
CHUNK_IMP = re.compile(
    r"import\s*\{([^}]*)\}\s*from\s*[\"']\./" + re.escape(API_MOD) + r"[\"']"
)

results = collections.Counter()
by_file = collections.defaultdict(set)
auth_cmds = collections.Counter()

for f in sorted(os.listdir(APP)):
    if not f.endswith(".js"):
        continue
    src = open(os.path.join(APP, f), encoding="utf-8", errors="replace").read()
    if API_MOD not in src:
        continue
    aliases = set()
    for imp in CHUNK_IMP.findall(src):
        for part in imp.split(","):
            part = part.strip()
            mm = re.match(r"([\w$]+)\s+as\s+([\w$]+)", part)
            if mm and mm.group(1) in exported_wrappers:
                aliases.add(mm.group(2))
            elif part in exported_wrappers:
                aliases.add(part)
    if not aliases:
        continue
    for a in aliases:
        for mm in re.finditer(re.escape(a) + r"\s*\(\s*[`\"']([^`\"']{2,80})[`\"']", src):
            cmd = mm.group(1)
            if "/" in cmd or " " in cmd or cmd.startswith("${"):
                continue
            results[cmd] += 1
            by_file[f].add(cmd)

# 4. auth endpoints: /api/auth/${e} call sites
for f in sorted(os.listdir(APP)):
    if not f.endswith(".js"):
        continue
    src = open(os.path.join(APP, f), encoding="utf-8", errors="replace").read()
    for mm in re.finditer(r"[\"']([a-zA-Z][\w\.\-]{2,50})[\"']", src):
        pass
    # auth wrappers be/xe
    for mm in re.finditer(r"\b(?:be|xe|SignIn|SignUp)\s*\(\s*[\"']([^\"']{2,60})[\"']", src):
        auth_cmds[mm.group(1)] += 1

out = {
    "contract": {
        "api_base": "https://api.clawsgo.cn",
        "marketing": "https://clawsgo.cn",
        "app_dev": "http://localhost:5173",
        "token_storage_key": "clawsgo_token",
        "envelope_request": {"data": "<payload>"},
        "envelope_response_ok": {"data": "<payload>"},
        "envelope_response_err": {"error": {"code": "...", "message": "..."}},
        "token_rotation_header": "set-auth-token",
        "unauthorized_behavior": "clear token -> redirect /login?redirect=<path>",
        "wrapper_variants": sorted(WRAPPERS),
    },
    "commands": sorted(results.items(), key=lambda x: -x[1]),
    "commands_by_file": {k: sorted(v) for k, v in sorted(by_file.items())},
    "auth_candidates": auth_cmds.most_common(),
}
with open(os.path.join(ROOT, "analysis", "api_commands.json"), "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=2)

print(f"\n=== COMMANDS ({len(results)}) ===")
for c, n in sorted(results.items()):
    print(f"  {n:>3}  {c}")

# fallback: dotted command-looking literals anywhere
allblob = ""
for f in sorted(os.listdir(APP)):
    if f.endswith(".js"):
        allblob += open(os.path.join(APP, f), encoding="utf-8", errors="replace").read()
dotted = collections.Counter(re.findall(r"[\"']([a-z][a-z0-9_]{1,20}\.[a-z][a-zA-Z0-9_]{1,30})[\"']", allblob))
interesting = {k: v for k, v in dotted.items() if v >= 2 and not k.endswith((".js", ".css", ".png", ".com", ".cn"))}
print(f"\n=== dotted literals ({len(interesting)}) ===")
for k, v in sorted(interesting.items()):
    print(f"  {v:>3}  {k}")
