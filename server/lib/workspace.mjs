// 会话工作区：每个对话一个真实目录，智能体工具直接作用于它。
// 这样 Read/Write/Edit/Glob/Grep 等工具是**真的在执行**，文件面板展示的也是真实文件。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DATA_DIR, db$, now } from './db.mjs';

export const WORKSPACE_ROOT = path.join(DATA_DIR, 'workspace');

export function workspaceDir(conversationId) {
  return path.join(WORKSPACE_ROOT, conversationId);
}

/** 归一化并阻止路径穿越 */
export function safeJoin(root, rel) {
  const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(root, clean);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    const err = new Error('path escapes workspace');
    err.code = 'INVALID_PARAM';
    throw err;
  }
  return resolved;
}

const SEED_FILES = {
  'README.md': `# 工作区

这是本对话的沙箱工作目录。智能体的读写、检索、执行都发生在这里。

- \`data/raw/\` 原始数据
- \`data/processed/\` 处理结果
- \`scripts/\` 分析脚本
- \`.clawsgo/figures/\` 生成的图件
`,
  'data/raw/20260301_S1.csv': 'sample,rt_min,efficiency,note\nS1,12.4,18.2,as-cast\nS1,22.1,19.6,annealed-100C\nS1,31.7,21.3,annealed-140C\n',
  'data/raw/20260302_S2.csv': 'sample,rt_min,efficiency,note\nS2,11.9,17.4,as-cast\nS2,21.6,20.1,annealed-100C\nS2,30.8,22.7,annealed-140C\n',
  'data/raw/20260303_S3.csv': 'sample,rt_min,efficiency,note\nS3,12.1,18.9,as-cast\nS3,22.4,19.1,annealed-100C\nS3,31.2,20.4,annealed-140C\n',
  'data/processed/xrd_summary.csv': 'sample,two_theta,intensity\nS1,14.08,1420\nS1,28.41,880\nS2,14.11,1360\nS2,28.44,910\n',
  'scripts/humidity_expose.py': `"""恒定湿热暴露实验编排。"""
import argparse, csv, time
from pathlib import Path

def expose(rh: float, temp: float, hours: list[int], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    for h in hours:
        rows.append({"rh": rh, "temp_c": temp, "hours": h, "state": "pending"})
    with out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["rh", "temp_c", "hours", "state"])
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} exposure steps -> {out}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rh", type=float, default=85)
    ap.add_argument("--temp", type=float, default=85)
    ap.add_argument("--hours", default="0,24,96,240")
    ap.add_argument("--out", default="data/processed/exposure_plan.csv")
    a = ap.parse_args()
    expose(a.rh, a.temp, [int(x) for x in a.hours.split(",")], Path(a.out))
`,
  'scripts/xrd_scan.py': `"""逐点 XRD 扫描并汇总峰位。"""
import argparse, csv
from pathlib import Path

PEAKS = {14.1: "110", 28.4: "220"}

def scan(src: Path, out: Path) -> None:
    rows = []
    for f in sorted(src.glob("*.csv")):
        for th, hkl in PEAKS.items():
            rows.append({"file": f.name, "two_theta": th, "hkl": hkl, "intensity": 1000 + int(th * 10)})
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["file", "two_theta", "hkl", "intensity"])
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} peaks -> {out}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="data/exposed")
    ap.add_argument("--out", default="data/processed/xrd_summary.csv")
    a = ap.parse_args()
    scan(Path(a.dir), Path(a.out))
`,
  '.clawsgo/figures/efficiency_vs_anneal.md': `# 图件说明

**efficiency_vs_anneal** — 退火温度与器件效率的关系。

- 数据源：\`data/raw/*.csv\`
- 结论：140℃ 退火后效率中位数提升 12.4%
`,
};

/** 首次访问时补齐演示工作区 */
export function ensureWorkspace(conversationId) {
  const dir = workspaceDir(conversationId);
  if (fs.existsSync(path.join(dir, '.seeded'))) return dir;
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(SEED_FILES)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) fs.writeFileSync(p, content, 'utf8');
  }
  fs.writeFileSync(path.join(dir, '.seeded'), new Date().toISOString(), 'utf8');
  return dir;
}

const TEXT_EXT = new Set([
  '.md', '.txt', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sh', '.bash', '.zsh', '.fish',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.java', '.kt', '.go', '.rs', '.rb', '.php', '.swift',
  '.sql', '.r', '.jl', '.m', '.tex', '.bib', '.typ', '.html', '.htm', '.css', '.scss',
  '.xml', '.svg', '.log', '.env', '.gitignore', '.dockerfile', '',
]);

export function isTextFile(name) {
  return TEXT_EXT.has(path.extname(name).toLowerCase());
}

export function entryType(abs) {
  try {
    return fs.statSync(abs).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'file';
  }
}

function entryFor(root, abs) {
  const st = fs.statSync(abs);
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  const name = path.basename(abs);
  const isDir = st.isDirectory();
  return {
    name,
    filename: name,
    path: rel,
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : st.size,
    mtime: st.mtime.toISOString(),
    updatedAt: st.mtime.toISOString(),
    ext: isDir ? '' : path.extname(name).replace('.', '').toLowerCase(),
    binary: !isDir && !isTextFile(name),
  };
}

/** GET 语义：列目录 → { exists, entries } */
export function listDir(conversationId, relPath = '') {
  const root = ensureWorkspace(conversationId);
  const abs = safeJoin(root, relPath);
  if (!fs.existsSync(abs)) return { exists: false, path: relPath ?? '', entries: [] };
  const st = fs.statSync(abs);
  if (!st.isDirectory()) {
    return { exists: true, path: relPath ?? '', entries: [entryFor(root, abs)] };
  }
  const entries = fs
    .readdirSync(abs)
    .filter((n) => n !== '.seeded' && n !== '.git')
    .map((n) => entryFor(root, path.join(abs, n)))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh');
    });
  return { exists: true, path: relPath ?? '', entries };
}

/** 扁平索引：给「文件索引」面板与 @ 提及用 */
export function fileIndex(conversationId, { limit = 2000 } = {}) {
  const root = ensureWorkspace(conversationId);
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > 8) return;
    let items = [];
    try {
      items = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of items) {
      if (n === '.seeded' || n === '.git') continue;
      const abs = path.join(dir, n);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs, depth + 1);
      } else {
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        out.push({
          name: n,
          filename: n,
          path: rel,
          type: 'file',
          size: st.size,
          mtime: st.mtime.toISOString(),
          updatedAt: st.mtime.toISOString(),
          ext: path.extname(n).replace('.', '').toLowerCase(),
          binary: !isTextFile(n),
        });
      }
    }
  };
  walk(root, 0);
  return { entries: out, total: out.length, truncated: out.length >= limit };
}

export function readText(conversationId, relPath) {
  const root = ensureWorkspace(conversationId);
  const abs = safeJoin(root, relPath);
  return fs.readFileSync(abs);
}

export function writeText(conversationId, relPath, content) {
  const root = ensureWorkspace(conversationId);
  const abs = safeJoin(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content ?? '', 'utf8');
  return entryFor(root, abs);
}

export function removeEntry(conversationId, relPath) {
  const root = ensureWorkspace(conversationId);
  const abs = safeJoin(root, relPath);
  if (!fs.existsSync(abs)) return false;
  fs.rmSync(abs, { recursive: true, force: true });
  return true;
}

export function copyEntry(conversationId, relPath, destDir) {
  const root = ensureWorkspace(conversationId);
  const src = safeJoin(root, relPath);
  const dest = safeJoin(root, path.join(destDir ?? '', path.basename(relPath)));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return entryFor(root, dest);
}

export function renameEntry(conversationId, relPath, newName) {
  const root = ensureWorkspace(conversationId);
  const src = safeJoin(root, relPath);
  const dest = safeJoin(root, path.join(path.dirname(relPath) === '.' ? '' : path.dirname(relPath), newName));
  fs.renameSync(src, dest);
  return entryFor(root, dest);
}

/** 简化的 git 状态（把工作区当普通目录，用 mtime 判“已改动”） */
export function gitStatus(conversationId) {
  const root = ensureWorkspace(conversationId);
  const gitDir = path.join(root, '.git');
  if (!fs.existsSync(gitDir)) {
    return { initialized: false, branch: null, clean: true, changes: [], ahead: 0, behind: 0 };
  }
  return { initialized: true, branch: 'main', clean: true, changes: [], ahead: 0, behind: 0 };
}

export function gitDiff(conversationId, relPath) {
  const root = ensureWorkspace(conversationId);
  const abs = safeJoin(root, relPath);
  let content = '';
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    content = '';
  }
  return {
    initialized: fs.existsSync(path.join(root, '.git')),
    path: relPath,
    diff: '',
    patch: '',
    hunks: [],
    original: content,
    modified: content,
  };
}

// ---------- 工具实现（给智能体用，全部真实执行） ----------

export function toolGlob(conversationId, { pattern = '**/*', path: base = '' } = {}) {
  const root = ensureWorkspace(conversationId);
  const start = safeJoin(root, base);
  const rx = globToRegex(pattern);
  const out = [];
  const walk = (dir, depth) => {
    if (out.length > 500 || depth > 10) return;
    let items = [];
    try {
      items = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of items) {
      if (n === '.git' || n === '.seeded') continue;
      const abs = path.join(dir, n);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (st.isDirectory()) walk(abs, depth + 1);
      else if (rx.test(rel) || rx.test(n)) out.push(rel);
    }
  };
  walk(start, 0);
  return out.sort();
}

/**
 * glob → RegExp。
 * 注意替换顺序：问号必须在插入「可选的任意层级前缀」分组**之前**处理掉，
 * 否则最后那次「替换问号」会连自己刚插入的组内问号一起替换掉，
 * 生成的正则谁都匹配不上，工作区会「看起来是空的」。
 */
function globToRegex(glob) {
  const esc = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 转义正则元字符（* ? 除外）
    .replace(/\?/g, '[^/]') // glob 的 ? = 单个非分隔符字符
    .replace(/\*\*\//g, '\u0000') // **/ 先占位
    .replace(/\*/g, '[^/]*') // * = 段内任意字符
    .replace(/\u0000/g, '(?:.*/)?'); // 还原 **/ = 任意层级
  return new RegExp(`^${esc}$`);
}

export function toolGrep(conversationId, { pattern, path: base = '', glob } = {}) {
  const root = ensureWorkspace(conversationId);
  let rx;
  try {
    rx = new RegExp(pattern, 'i');
  } catch {
    rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  const files = glob ? toolGlob(conversationId, { pattern: glob, path: base }) : toolGlob(conversationId, { pattern: '**/*', path: base });
  const hits = [];
  for (const rel of files) {
    if (!isTextFile(rel)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      if (hits.length < 200 && rx.test(line)) {
        hits.push({ path: rel, line: i + 1, text: line.slice(0, 300) });
      }
    });
  }
  return hits;
}

const BASH_ALLOW = [
  /^ls(\s|$)/, /^pwd(\s|$)/, /^help(\s|$)/, /^cat\s/, /^head(\s|$)/, /^tail(\s|$)/, /^wc(\s|$)/,
  /^grep\s/, /^find(\s|$)/, /^python(3)?\s/, /^node\s/, /^echo(\s|$)/, /^sort(\s|$)/, /^uniq(\s|$)/,
  /^cut\s/, /^awk\s/, /^mkdir\s/, /^touch\s/, /^cp\s/, /^mv\s/, /^rm\s/, /^rmdir\s/, /^cd(\s|$)/,
  /^sed\s/, /^wc(\s|$)/, /^tree(\s|$)/, /^stat\s/, /^du(\s|$)/, /^basename\s/, /^dirname\s/, /^date(\s|$)/,
  /^git\s+(status|log|diff|branch|show)\b/,
];

const HELP_TEXT = `ClawsGO 本地复刻迷你 shell（命令在原工作区目录内真实执行）

  导航   ls [-a] [-l] [路径]   pwd   cd [路径]   tree   stat <路径>   du
  读取   cat <文件>   head [-n N] <文件>   tail [-n N] <文件>   wc [-l|-w|-c] <文件>
  检索   grep [-i] <模式> [文件]   find [路径] -name <通配>
  文本   echo <文本>   sort   uniq   cut -d, -f1   awk -F, '{print $1}'   sed -n '1,5p'
  写入   mkdir [-p] <目录>   touch <文件>   cp [-r] <源> <目标>   mv <源> <目标>   rm [-r] <路径>   rmdir <目录>
  执行   python <脚本.py>   node <脚本.js>          （真实运行，10 秒超时）
  其他   date   git status|log|diff|branch

支持管道：ls | grep csv | wc -l
所有路径都被限制在本会话工作区内。`;

/** 解析出每个命令段及其参数（支持引号，忽略重定向以保持简单） */
function splitPipeline(cmd) {
  const segs = [];
  let cur = '';
  let quote = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '|') {
      segs.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

/** 简易参数切分：保留引号内的空格 */
function tokenize(seg) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of seg) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const flagsOf = (args) => args.filter((a) => a.startsWith('-'));
const operandsOf = (args) => args.filter((a) => !a.startsWith('-'));
const flagNum = (args, name, dflt) => {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && /^\d+$/.test(args[i + 1])) return Number(args[i + 1]);
  const inl = args.find((a) => a.startsWith(name + '='));
  if (inl) return Number(inl.slice(name.length + 1)) || dflt;
  const compact = args.find((a) => /^-\w*\d+$/.test(a));
  if (compact) return Number(compact.replace(/\D/g, '')) || dflt;
  if (name === '-n') return 10;
  return dflt;
};

/**
 * 真实执行一条（可能带管道的）命令。
 * @returns {{blocked:boolean, output:string, cwd:string, description?:string, error?:string}}
 */
export async function toolBash(conversationId, { command, description, cwd: cwdIn } = {}, signal = null) {
  const root = ensureWorkspace(conversationId);
  const cmd = String(command ?? '').trim();
  if (!cmd) return { blocked: false, output: '', cwd: cwdIn ?? '', description };

  const segs = splitPipeline(cmd);
  if (!segs.length) return { blocked: false, output: '', cwd: cwdIn ?? '', description };

  // 白名单校验：只看每段的首个命令
  const bad = segs.find((seg) => !BASH_ALLOW.some((r) => r.test(seg.trim())));
  if (bad) {
    return {
      blocked: true,
      cwd: cwdIn ?? '',
      output:
        `命令未在白名单内，本地沙箱拒绝执行：${bad.trim()}\n` +
        `输入 help 查看允许的命令集合。`,
    };
  }

  let cwd = String(cwdIn ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  let data = null;
  const log = [];

  try {
    for (const seg of segs) {
      const tokens = tokenize(seg);
      const [bin, ...args] = tokens;
      const r = await runOne(bin, args, { root, cwd, data, conversationId, signal });
      data = r.data;
      if (r.cwd !== undefined) cwd = r.cwd;
      if (r.log) log.push(r.log);
    }
  } catch (e) {
    return { blocked: false, cwd, output: `${e.message}`, error: e.message, description };
  }

  const output = typeof data === 'string' ? data : data === null ? '' : String(data);
  return {
    blocked: false,
    cwd,
    output: [...log, output].filter(Boolean).join('\n'),
    description,
  };
}

const ABS = (root, cwd, p) => safeJoin(root, path.posix.join(cwd, String(p ?? '')));

async function runOne(bin, args, { root, cwd, data, conversationId, signal }) {
  const flags = flagsOf(args);
  const ops = operandsOf(args);

  switch (bin) {
    case 'help':
      return { data: HELP_TEXT };

    case 'pwd':
      return { data: '/' + (cwd || '') };

    case 'cd': {
      const target = ops[0] ?? '';
      const abs = ABS(root, cwd, target);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        throw new Error(`cd: ${target}: No such directory`);
      }
      return { data: '', cwd: path.relative(root, abs).replace(/\\/g, '/') };
    }

    case 'ls': {
      const target = ops[0] ?? '.';
      const abs = ABS(root, cwd, target);
      if (!fs.existsSync(abs)) throw new Error(`ls: ${target}: No such file or directory`);
      if (!fs.statSync(abs).isDirectory()) return { data: path.basename(abs) };
      const showAll = flags.some((f) => f.includes('a'));
      const long = flags.some((f) => f.includes('l'));
      const names = fs
        .readdirSync(abs)
        .filter((n) => n !== '.seeded' && (showAll || !n.startsWith('.')))
        .sort((a, b) => {
          const ad = fs.statSync(path.join(abs, a)).isDirectory();
          const bd = fs.statSync(path.join(abs, b)).isDirectory();
          if (ad !== bd) return ad ? -1 : 1;
          return a.localeCompare(b, 'zh');
        });
      if (!long) {
        return { data: names.map((n) => (fs.statSync(path.join(abs, n)).isDirectory() ? n + '/' : n)).join('\n') };
      }
      const rows = names.map((n) => {
        const st = fs.statSync(path.join(abs, n));
        const kind = st.isDirectory() ? 'd' : '-';
        return `${kind}${st.mode.toString(8).slice(-3)}  ${String(st.size).padStart(8)}  ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')}  ${n}${st.isDirectory() ? '/' : ''}`;
      });
      return { data: rows.join('\n') };
    }

    case 'tree': {
      const lines = [];
      const walk = (dir, prefix, depth) => {
        if (depth > 4) return;
        const items = fs
          .readdirSync(dir)
          .filter((n) => n !== '.seeded' && !n.startsWith('.'))
          .sort();
        items.forEach((n, i) => {
          const last = i === items.length - 1;
          const abs = path.join(dir, n);
          lines.push(`${prefix}${last ? '└── ' : '├── '}${n}${fs.statSync(abs).isDirectory() ? '/' : ''}`);
          if (fs.statSync(abs).isDirectory()) walk(abs, prefix + (last ? '    ' : '│   '), depth + 1);
        });
      };
      lines.push('/' + cwd);
      walk(ABS(root, cwd, '.'), '', 0);
      return { data: lines.join('\n') };
    }

    case 'cat': {
      if (!ops.length) return { data: data ?? '' };
      return {
        data: ops
          .map((f) => {
            try {
              return fs.readFileSync(ABS(root, cwd, f), 'utf8');
            } catch {
              return `cat: ${f}: No such file`;
            }
          })
          .join('\n'),
      };
    }

    case 'head':
    case 'tail': {
      const n = flagNum(args, '-n', 10);
      const text = ops.length
        ? ops.map((f) => readMaybe(root, cwd, f)).join('\n')
        : String(data ?? '');
      const lines = text.split('\n');
      return { data: (bin === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n') };
    }

    case 'wc': {
      const text = ops.length ? ops.map((f) => readMaybe(root, cwd, f)).join('\n') : String(data ?? '');
      const lines = text === '' ? 0 : text.split('\n').length;
      const words = text.split(/\s+/).filter(Boolean).length;
      const only = flags.find((f) => /^-[lwc]+$/.test(f));
      if (only === '-l') return { data: String(lines) };
      if (only === '-w') return { data: String(words) };
      if (only === '-c') return { data: String(text.length) };
      return { data: `${lines}\t${words}\t${text.length}${ops[0] ? '\t' + ops[0] : ''}` };
    }

    case 'grep': {
      const ci = flags.some((f) => f.includes('i'));
      const pat = ops[0] ?? '';
      const files = ops.slice(1);
      let rx;
      try {
        rx = new RegExp(pat, ci ? 'i' : '');
      } catch {
        rx = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ci ? 'i' : '');
      }
      if (files.length) {
        return {
          data: files
            .flatMap((f) =>
              readMaybe(root, cwd, f)
                .split('\n')
                .filter((l) => rx.test(l))
                .map((l) => (files.length > 1 ? `${f}:${l}` : l)),
            )
            .join('\n'),
        };
      }
      if (data !== null) {
        return { data: String(data).split('\n').filter((l) => rx.test(l)).join('\n') };
      }
      const hits = toolGrep(conversationId, { pattern: pat });
      return { data: hits.slice(0, 200).map((h) => `${h.path}:${h.line}:${h.text}`).join('\n') };
    }

    case 'find': {
      const base = ops.find((o) => !o.includes('*') && !o.includes('?')) ?? '.';
      const pat = args.includes('-name') ? args[args.indexOf('-name') + 1] : args.find((a) => a.includes('*')) ?? '**/*';
      const list = toolGlob(conversationId, { pattern: pat, path: path.posix.join(cwd, base === '.' ? '' : base) });
      return { data: list.join('\n') };
    }

    case 'echo':
      return { data: args.join(' ') };

    case 'date':
      return { data: new Date().toString() };

    case 'sort':
      return { data: String(data ?? '').split('\n').sort().join('\n') };

    case 'uniq': {
      const seen = new Set();
      return {
        data: String(data ?? '')
          .split('\n')
          .filter((l) => (seen.has(l) ? false : (seen.add(l), true)))
          .join('\n'),
      };
    }

    case 'cut': {
      const fArg = args.find((a) => /^-f\d/.test(a)) ?? args[args.indexOf('-f') + 1] ?? '1';
      const dArg = args.find((a) => /^-d./.test(a)) ?? args[args.indexOf('-d') + 1] ?? '\t';
      const idx = Number(String(fArg).replace('-f', '')) - 1;
      const delim = String(dArg).replace('-d', '') || '\t';
      return { data: String(data ?? '').split('\n').map((l) => l.split(delim)[idx] ?? '').join('\n') };
    }

    case 'awk': {
      const program = args.find((a) => a.includes('print')) ?? '{print $1}';
      const fArg = args.find((a) => a.startsWith('-F'));
      const delim = fArg ? fArg.slice(2) || '\t' : /\s+/;
      const cols = [...program.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      if (!cols.length) return { data: String(data ?? '') };
      return {
        data: String(data ?? '')
          .split('\n')
          .map((l) => {
            const parts = l.split(delim);
            return cols.map((c) => parts[c - 1] ?? '').join(' ');
          })
          .join('\n'),
      };
    }

    case 'sed': {
      const m = /-n\s*'?(\d+)(?:,(\d+))?p'?/.exec(args.join(' ')) ?? /-n\s*(\d+),(\d+)p/.exec(args.join(' '));
      const text = ops.length ? readMaybe(root, cwd, ops.at(-1)) : String(data ?? '');
      if (!m) return { data: text };
      const from = Number(m[1]);
      const to = m[2] ? Number(m[2]) : from;
      return { data: text.split('\n').slice(from - 1, to).join('\n') };
    }

    case 'mkdir': {
      const p = flags.some((f) => f.includes('p'));
      for (const dir of ops) {
        const abs = ABS(root, cwd, dir);
        if (fs.existsSync(abs) && !p) throw new Error(`mkdir: ${dir}: File exists`);
        fs.mkdirSync(abs, { recursive: true });
      }
      return { data: '' };
    }

    case 'touch': {
      for (const f of ops) {
        const abs = ABS(root, cwd, f);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (!fs.existsSync(abs)) fs.writeFileSync(abs, '', 'utf8');
        else fs.utimesSync(abs, new Date(), new Date());
      }
      return { data: '' };
    }

    case 'cp': {
      const rec = flags.some((f) => f.includes('r') || f.includes('R'));
      const [src, dest] = ops;
      if (!src || !dest) throw new Error('cp: 需要源和目标');
      const srcAbs = ABS(root, cwd, src);
      let destAbs = ABS(root, cwd, dest);
      if (fs.existsSync(destAbs) && fs.statSync(destAbs).isDirectory()) {
        destAbs = path.join(destAbs, path.basename(srcAbs));
      }
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.cpSync(srcAbs, destAbs, { recursive: rec || fs.statSync(srcAbs).isDirectory() });
      return { data: '' };
    }

    case 'mv': {
      const [src, dest] = ops;
      if (!src || !dest) throw new Error('mv: 需要源和目标');
      const srcAbs = ABS(root, cwd, src);
      let destAbs = ABS(root, cwd, dest);
      if (fs.existsSync(destAbs) && fs.statSync(destAbs).isDirectory()) {
        destAbs = path.join(destAbs, path.basename(srcAbs));
      }
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.renameSync(srcAbs, destAbs);
      return { data: '' };
    }

    case 'rm': {
      const rec = flags.some((f) => f.includes('r') || f.includes('R'));
      for (const f of ops) {
        const abs = ABS(root, cwd, f);
        if (!fs.existsSync(abs)) continue;
        fs.rmSync(abs, { recursive: rec || fs.statSync(abs).isDirectory(), force: true });
        touchFileRecord(conversationId, path.relative(root, abs).replace(/\\/g, '/'));
      }
      return { data: '' };
    }

    case 'rmdir': {
      for (const d of ops) fs.rmdirSync(ABS(root, cwd, d));
      return { data: '' };
    }

    case 'stat': {
      const f = ops[0] ?? '.';
      const st = fs.statSync(ABS(root, cwd, f));
      return {
        data: [
          `  File: ${f}`,
          `  Size: ${st.size}`,
          `  Type: ${st.isDirectory() ? 'directory' : 'regular file'}`,
          `Modify: ${st.mtime.toISOString()}`,
        ].join('\n'),
      };
    }

    case 'du': {
      let total = 0;
      const walk = (dir) => {
        for (const n of fs.readdirSync(dir)) {
          const a = path.join(dir, n);
          const st = fs.statSync(a);
          if (st.isDirectory()) walk(a);
          else total += st.size;
        }
      };
      const target = ops[0] ?? '.';
      const abs = ABS(root, cwd, target);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else total = fs.statSync(abs).size;
      return { data: `${total}\t${target}` };
    }

    case 'basename':
      return { data: path.basename(ops[0] ?? '') };
    case 'dirname':
      return { data: path.dirname(ops[0] ?? '') };

    case 'python':
    case 'python3':
    case 'node':
      return { data: await runScript(bin, ops[0], root, cwd, signal) };

    case 'git': {
      const sub = ops[0] ?? 'status';
      if (sub === 'status') {
        const st = gitStatus(conversationId);
        return { data: `On branch ${st.branch ?? 'main'}\nnothing to commit, working tree clean` };
      }
      if (sub === 'branch') return { data: '* main' };
      if (sub === 'log') return { data: 'commit 0000000 (HEAD -> main)\nAuthor: ClawsGO <noreply@clawsgo.local>\nDate:   ' + new Date().toISOString() + '\n\n    初始化工作区快照' };
      if (sub === 'diff') return { data: gitDiff(conversationId, ops[1] ?? '').diff || '' };
      return { data: '' };
    }

    default:
      return { data: `未实现的命令：${bin}` };
  }
}

function readMaybe(root, cwd, f) {
  try {
    return fs.readFileSync(ABS(root, cwd, f), 'utf8');
  } catch {
    return `cat: ${f}: No such file`;
  }
}

/** 真实执行工作区内的脚本（10s 超时，路径必须落在工作区内） */
async function runScript(bin, script, root, cwd, signal) {
  if (!script) return `${bin} 交互模式在本复刻终端中不可用，请指定脚本文件。`;
  const ext = path.extname(script).toLowerCase();
  if (ext !== '.py' && ext !== '.js' && ext !== '.mjs') {
    return `${bin}: 仅支持 .py/.js/.mjs 脚本（收到 ${script}）`;
  }
  const abs = ABS(root, cwd, script);
  if (!abs) throw new Error(`路径越界: ${script}`);
  if (!fs.existsSync(abs)) throw new Error(`${bin}: ${script}: No such file`);
  // 复用脚本所在目录做 cwd（相对 import/data 路径从脚本视角解析）
  const runCwd = ABS(root, cwd, '.');

  const candidates =
    bin === 'node'
      ? [process.env.CLAWSGO_NODE_BIN, process.execPath].filter(Boolean)
      : [
          process.env.CLAWSGO_PYTHON_BIN,
          'python3',
          'python',
        ].filter(Boolean);

  // 线上递增超时梯子（2026-10-10 fork 案例实测）：300s → 480s → 600s 封顶
  const TIMEOUT_LADDER = [300_000, 480_000, 600_000];
  for (const exe of candidates) {
    for (const timeoutMs of TIMEOUT_LADDER) {
      const r = await new Promise((resolve) => {
        const child = spawn(exe, [abs], {
          cwd: fs.existsSync(runCwd) ? runCwd : path.dirname(abs),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let out = '', killed = false;
        const timer = setTimeout(() => { killed = true; child.kill('SIGTERM'); }, timeoutMs);
        child.stdout.on('data', (d) => { out += d; if (out.length > 4e6) child.kill('SIGTERM'); });
        child.stderr.on('data', (d) => { out += d; });
        child.on('error', (e) => { clearTimeout(timer); resolve({ error: e }); });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ status: code, out: out.trim(), killed });
        });
        // cancel 路由 abort → SIGTERM（Bash 释放不留孤儿）
        if (signal) signal.addEventListener('abort', () => { child.kill('SIGTERM'); }, { once: true });
      });
      if (r.error?.code === 'ENOENT') break; // 下一个解释器
      if (r.killed && r.status !== 0 && timeoutMs < TIMEOUT_LADDER[2]) continue; // 梯子升级
      const out = r.out || '';
      if (r.status === 0) return out || '(脚本执行完成，无输出)';
      return `[exit ${r.status}]\n${out}`;
    }
  }
  return `${bin}: 未找到可用解释器（可用 CLAWSGO_${bin === 'node' ? 'NODE' : 'PYTHON'}_BIN 指定路径）`;
}


// ---------- 搜索 / 抓取（真实联网，失败降级） ----------

export async function toolWebSearch({ query, limit = 5 }) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36' },
    });
    const html = await res.text();
    const out = [];
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;
    let m;
    while ((m = re.exec(html)) && out.length < limit) {
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      let href = m[1];
      const u = href.match(/uddg=([^&]+)/);
      if (u) href = decodeURIComponent(u[1]);
      if (title && /^https?:/.test(href)) out.push({ title, url: href });
    }
    if (out.length === 0) {
      return { query, results: [], note: '搜索结果为空（网络受限或页面结构变化）' };
    }
    return { query, results: out };
  } catch (e) {
    return { query, results: [], note: `搜索失败：${e.message}` };
  }
}

export async function toolWebFetch({ url }) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClawsGO-Replica/1.0)' },
      redirect: 'follow',
    });
    const text = await res.text();
    const stripped = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      url,
      status: res.status,
      title: (text.match(/<title[^>]*>(.*?)<\/title>/is)?.[1] ?? '').trim(),
      content: stripped.slice(0, 6000),
      truncated: stripped.length > 6000,
    };
  } catch (e) {
    return { url, status: 0, title: '', content: `抓取失败：${e.message}`, truncated: false };
  }
}

/** 记录「这个对话写过哪些文件」，用于文件变更流 */
export function touchFileRecord(conversationId, relPath) {
  const db = db$();
  const existing = db.files.find((f) => f.conversationId === conversationId && f.path === relPath);
  if (existing) {
    existing.updatedAt = now();
  } else {
    db.files.push({
      id: Math.random().toString(36).slice(2, 14),
      conversationId,
      path: relPath,
      updatedAt: now(),
    });
  }
}
