#!/usr/bin/env python3
"""Static analysis of the mirrored clawsgo front-end bundles.

Extracts: API endpoints, route tree, i18n namespaces, feature inventory,
runtime deps, and animation/motion evidence.
"""
import os, re, json, collections

ROOT = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(ROOT, "app", "assets")
OUT = os.path.join(ROOT, "analysis")
os.makedirs(OUT, exist_ok=True)

files = sorted(f for f in os.listdir(APP) if f.endswith(".js"))
texts = {}
for f in files:
    try:
        texts[f] = open(os.path.join(APP, f), encoding="utf-8", errors="replace").read()
    except Exception:
        pass

allblob = "\n".join(texts.values())
report = {}

# ---------- 1. API endpoints ----------
ep = collections.Counter()
pat = re.compile(r"""["'`](/api/[A-Za-z0-9_\-/\.\{\}\[\]:]{2,80})["'`]""")
for f, s in texts.items():
    for m in pat.findall(s):
        ep[m] += 1
report["api_paths"] = sorted(ep.items(), key=lambda x: -x[1])

# ---------- 2. absolute hosts ----------
hosts = collections.Counter(re.findall(r"https?://([a-z0-9\.\-]+\.(?:cn|ai|com|io|dev|net))", allblob))
report["hosts"] = hosts.most_common(40)

# ---------- 3. route path literals (longest first) ----------
rp = collections.Counter()
for f, s in texts.items():
    for m in re.findall(r"""["'`](/[A-Za-z0-9_\-\[\]\.$/:]{2,70})["'`]""", s):
        if m.startswith("/assets"):
            continue
        rp[m] += 1
report["route_literals"] = sorted(rp.items(), key=lambda x: -x[1])[:200]

# ---------- 4. i18n keys (snake_case message ids) ----------
i18n = set(re.findall(r"""["'`]([a-z][a-z0-9]*(?:_[a-z0-9]+){1,6})["'`]""", allblob))
report["i18n_key_count"] = len(i18n)
report["i18n_keys_sample"] = sorted(i18n)[:400]

# ---------- 5. HTTP verbs / headers ----------
report["verbs"] = collections.Counter(
    re.findall(r"""method:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]""", allblob)
).most_common()
report["sse_event_names"] = sorted(set(re.findall(
    r"""event:\s*["'`]([a-z_\-]{3,30})["'`]""", allblob)))[:60]

# ---------- 6. feature libraries present ----------
LIB_SIGNS = {
    "monaco-editor": ["monaco", "editor.api"],
    "shiki": ["shiki", "createHighlighter"],
    "katex": ["katex"],
    "mermaid": ["mermaid", "architectureDiagram"],
    "framer-motion": ["framer-motion", "motionValue", "useMotionValue"],
    "gsap": ["gsap", "ScrollTrigger"],
    "react-query": ["QueryClient", "useQuery"],
    "tanstack-router": ["createFileRoute", "notFoundRoute"],
    "zustand": ["createStore", "useStore"],
    "radix-ui": ["FloatingPortal", "usePositioner", "DirectionContext"],
    "shadcn": ["cn(", "cva("],
    "tailwind": ["tailwind", "--tw-"],
    "tiptap": ["tiptap", "prosemirror"],
    "tldraw": ["tldraw"],
    "xterm": ["xterm", "Terminal"],
    "html-to-docx": ["html-to-docx"],
    "jszip": ["JSZip", "zip"],
    "aliyun-captcha": ["AliyunCaptcha"],
    "i18next": ["i18next", "useTranslation"],
    "dnd-kit": ["DndContext", "useDraggable"],
    "recharts": ["recharts", "ResponsiveContainer"],
    "echarts": ["echarts"],
    "three": ["THREE", "WebGLRenderer"],
    "pdfjs": ["pdfjs", "getDocument"],
    "lottie": ["lottie"],
}
feat = {}
for name, signs in LIB_SIGNS.items():
    hits = [s for s in signs if re.search(re.escape(s), allblob, re.I)]
    if hits:
        feat[name] = hits
report["libraries"] = feat

# ---------- 7. animation evidence ----------
anim = {}
ANIM_PAT = {
    "css @keyframes": r"@keyframes\s+([A-Za-z0-9_\-]+)",
    "framer variants": r"variants:\s*\{",
    "framer transition": r"transition:\s*\{\s*(?:type|duration|ease)",
    "gsap timeline": r"gsap\.timeline|\.to\(|\.fromTo\(",
    "scroll trigger": r"ScrollTrigger",
    "view transitions": r"startViewTransition|view-transition-name",
    "web animations api": r"\.animate\(|new Animation\(",
    "cubic-bezier": r"cubic-bezier\([^)]*\)",
    "spring": r"type:\s*[\"']spring[\"']",
    "motion.div": r"motion\.(?:div|span|section|h1|h2|p)\b",
    "AnimatePresence": r"AnimatePresence",
    "layoutId": r"layoutId",
}
for k, p in ANIM_PAT.items():
    hits = re.findall(p, allblob)
    if hits:
        uniq = sorted(set(hits))
        anim[k] = {"count": len(hits), "sample": uniq[:25]}
report["animation"] = anim

# keyframes in css
css = ""
cssf = os.path.join(APP, "index-Bk3BrKyc.css")
if os.path.exists(cssf):
    css = open(cssf, encoding="utf-8", errors="replace").read()
    report["css_bytes"] = len(css)
    report["css_keyframes"] = sorted(set(re.findall(r"@keyframes\s+([A-Za-z0-9_\-]+)", css)))
    report["css_custom_props"] = len(set(re.findall(r"--[a-z0-9\-]+", css)))

with open(os.path.join(OUT, "app_analysis.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)

# ---------- console summary ----------
print("=" * 70)
print("API PATHS:", len(report["api_paths"]))
for p, c in report["api_paths"][:120]:
    print(f"   {c:>3}  {p}")
print("=" * 70)
print("HOSTS:", report["hosts"])
print("=" * 70)
print("LIBRARIES:", json.dumps(report["libraries"], ensure_ascii=False, indent=2))
print("=" * 70)
print("ANIMATION:", json.dumps(report["animation"], ensure_ascii=False, indent=2)[:3000])
print("=" * 70)
print("CSS KEYFRAMES:", report.get("css_keyframes"))
print("CSS BYTES:", report.get("css_bytes"), "custom props:", report.get("css_custom_props"))
print("i18n keys:", report["i18n_key_count"])
print("SSE events:", report["sse_event_names"])
print("verbs:", report["verbs"])
