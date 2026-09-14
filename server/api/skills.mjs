// /api/skills —— 团队技能库 + 技能市场 + 主机技能。
//
// 契约来源：app/assets 技能面板（getSkills / getSkillDetail / getSkillFile /
//           searchSkillMarket / installSkill / setSkillEnabled / installHostSkill）。
//
// 技能是**真实落盘**的：每个技能在 server/data/skills/<slug>/ 下有一份 SKILL.md 与脚本，
// getSkillFile 直接读盘，所以要复现「点开看技能源码」是真的能看到内容。
import fs from 'node:fs';
import path from 'node:path';
import { db$, uuid, now, save } from '../lib/db.mjs';
import { skill } from '../lib/shapes.mjs';
import { req, notFound, need, conflict, badRequest } from '../lib/errors.mjs';

export const SKILLS_DIR = path.join(path.resolve(import.meta.dirname, '..'), 'data', 'skills');

/* ------------------------------------------------------------------ */
/* 内置技能源码（真实写入磁盘）                                        */
/* ------------------------------------------------------------------ */

const BUILTIN = {
  'literature-review': {
    title: '文献综述',
    description: '检索、筛选、抽取、成文一条龙：给定研究问题，产出带证据表的综述初稿与 PRISMA 流程图。',
    version: '1.4.0',
    tags: ['research', 'review', 'prisma'],
    files: {
      'SKILL.md': `---
name: literature-review
description: 给定研究问题，检索公开文献并按 PRISMA 流程产出综述初稿。
version: 1.4.0
---

# 文献综述

## 何时使用
用户要求「调研 / 综述 / 检索文献 / 写 review / 找证据」时。

## 流程
1. **拆问题** — 把研究问题拆成 PICO（人群 / 干预 / 对照 / 结局），明确纳入排除标准。
2. **定检索式** — 为每个数据库生成检索式，留档，保证可复现。
3. **去重筛选** — 按标题摘要初筛，再全文复筛，记录每一层的数量。
4. **抽数据** — 用统一表格抽 研究类型 / 样本量 / 干预 / 结局 / 偏倚风险。
5. **成文** — 引言、方法（必须含 PRISMA 流程图）、结果、讨论、局限。

## 硬约束
- 任何数字都要能回溯到具体文献，禁止凭印象写结论。
- 检索式、日期、数据库版本全部写进方法章节。
- 证据不足时明确写「证据不足」，不要用模糊措辞掩盖。
`,
      'prisma.py': `#!/usr/bin/env python3
"""生成 PRISMA 2020 流程图（Mermaid 格式）。"""
import sys

def prisma(identified, duplicates, screened, excluded_title, fulltext, excluded_full, included):
    return f"""flowchart TD
    A[数据库检索 n={identified}] --> B[去重后 n={identified - duplicates}]
    B --> C[标题摘要筛选 n={screened}]
    C -->|排除 n={excluded_title}| X1[排除]
    C --> D[全文评估 n={fulltext}]
    D -->|排除 n={excluded_full}| X2[排除]
    D --> E[纳入定性合成 n={included}]
"""

if __name__ == "__main__":
    nums = [int(x) for x in sys.argv[1:8]] or [1240, 210, 1030, 780, 250, 180, 70]
    print(prisma(*nums))
`,
      'extract.py': `#!/usr/bin/env python3
"""把 CSV 形式的文献表抽取成证据表。"""
import csv, sys

def extract(path):
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    return [
        {
            "title": r.get("title", "").strip(),
            "year": r.get("year", "").strip(),
            "design": r.get("design", "").strip(),
            "n": r.get("n", "").strip(),
            "outcome": r.get("outcome", "").strip(),
            "risk": r.get("risk", "unclear").strip(),
        }
        for r in rows
    ]

if __name__ == "__main__":
    for row in extract(sys.argv[1]):
        print(row)
`,
    },
  },

  'prisma-flow': {
    title: 'PRISMA 流程图',
    description: '把筛选各层的计数渲染成 PRISMA 2020 流程图，输出 Mermaid / SVG。',
    version: '1.1.2',
    tags: ['research', 'figure'],
    files: {
      'SKILL.md': `---
name: prisma-flow
description: 依据各层筛选计数生成 PRISMA 2020 流程图。
version: 1.1.2
---

# PRISMA 流程图

输入 7 个计数：检索命中、去重、初筛、初筛排除、全文评估、全文排除、纳入。
输出 Mermaid flowchart，并给出 SVG 渲染指令。

## 计数必须自洽
\`identified - duplicates == screened\`
\`screened - excluded_title == fulltext\`
\`fulltext - excluded_full == included\`
任一等式不成立就报错，不要「抹平」数字。
`,
      'render.mjs': `// 生成 Mermaid 源码
export function mermaid(c) {
  const bad = [];
  if (c.identified - c.duplicates !== c.screened) bad.push('identified - duplicates != screened');
  if (c.screened - c.excludedTitle !== c.fulltext) bad.push('screened - excludedTitle != fulltext');
  if (c.fulltext - c.excludedFull !== c.included) bad.push('fulltext - excludedFull != included');
  if (bad.length) throw new Error('计数不自洽: ' + bad.join('; '));
  return [
    'flowchart TD',
    \`    A[检索 n=\${c.identified}] --> B[去重后 n=\${c.screened}]\`,
    \`    B --> C[初筛 n=\${c.screened}]\`,
    \`    C -->|排除 n=\${c.excludedTitle}| X1[排除]\`,
    \`    D[全文 n=\${c.fulltext}] --> E[纳入 n=\${c.included}]\`,
  ].join('\\n');
}
`,
    },
  },

  'latex-manuscript': {
    title: 'LaTeX 手稿',
    description: '按期刊模板搭手稿骨架，处理引用、图表编号与参考文献。',
    version: '2.0.1',
    tags: ['writing', 'latex'],
    files: {
      'SKILL.md': `---
name: latex-manuscript
description: 生成符合期刊要求的 LaTeX 手稿骨架。
version: 2.0.1
---

# LaTeX 手稿

## 骨架
- \`main.tex\` 主文件，负责 \\input 各章节
- \`sections/\` 各章节
- \`figures/\` 图
- \`refs.bib\` 参考文献

## 规范
- 图表引用一律 \\autoref，不要手写「图 3」。
- 数字与单位之间用 \\, 留细空格。
- 编译链：pdflatex → bibtex → pdflatex ×2。
`,
      'main.tex': `\\documentclass[11pt]{article}
\\usepackage{graphicx,amsmath,hyperref,booktabs}
\\usepackage[authoryear]{natbib}

\\title{Manuscript Title}
\\author{Author One\\\\Author Two}
\\date{\\today}

\\begin{document}
\\maketitle
\\begin{abstract}
Abstract text.
\\end{abstract}
\\input{sections/introduction}
\\bibliographystyle{plainnat}
\\bibliography{refs}
\\end{document}
`,
      'Makefile': `all: main.pdf

main.pdf: main.tex refs.bib sections/*.tex
	pdflatex -interaction=nonstopmode main
	bibtex main
	pdflatex -interaction=nonstopmode main
	pdflatex -interaction=nonstopmode main

clean:
	rm -f *.aux *.bbl *.blg *.log *.out
`,
    },
  },

  'meta-analysis': {
    title: 'Meta 分析',
    description: '效应量合并、异质性检验、森林图与漏斗图。',
    version: '0.9.4',
    tags: ['statistics', 'figure'],
    files: {
      'SKILL.md': `---
name: meta-analysis
description: 从各研究效应量出发做随机/固定效应合并并出图。
version: 0.9.4
---

# Meta 分析

## 步骤
1. 统一效应量（OR / RR / SMD / MD），记录方向。
2. 异质性：Q 检验 + I²。I² > 50% 用随机效应。
3. 合并：DerSimonian-Laird（随机）或 inverse-variance（固定）。
4. 敏感性分析：逐一剔除；按研究质量分组。
5. 发表偏倚：漏斗图 + Egger 检验（研究数 ≥ 10 才有意义）。

## 报告
必须同时给 点估计、95% CI、I²、τ²、Q 的 p 值。缺一不可。
`,
      'pool.py': `#!/usr/bin/env python3
"""逆方差法合并效应量。"""
import math

def pool(effects, variances):
    w = [1 / v for v in variances]
    sw = sum(w)
    est = sum(wi * e for wi, e in zip(w, effects)) / sw
    se = math.sqrt(1 / sw)
    return est, est - 1.96 * se, est + 1.96 * se

if __name__ == "__main__":
    print(pool([0.42, 0.31, 0.55], [0.04, 0.09, 0.06]))
`,
    },
  },

  'data-cleaning': {
    title: '数据清洗',
    description: '缺失值、异常值、单位与编码统一，产出可追溯的清洗日志。',
    version: '1.2.0',
    tags: ['data', 'pipeline'],
    files: {
      'SKILL.md': `---
name: data-cleaning
description: 把原始表格整理成可分析的数据集，并记录每一步改动。
version: 1.2.0
---

# 数据清洗

## 铁律
1. **原始文件只读**，清洗结果另存。
2. 每一步都要写进清洗日志：改了哪些行、为什么改。
3. 缺失值不许静默填 0 —— 要么删行并记录，要么插补并标注方法。
4. 单位统一后再合并，不要在混合单位上做统计。
`,
      'clean.py': `#!/usr/bin/env python3
"""最小可用清洗器：单位统一 + 缺失值统计。"""
import csv, sys, json

LOG = []

def clean(rows):
    out = []
    for i, r in enumerate(rows, start=2):
        if not r.get("value", "").strip():
            LOG.append({"line": i, "action": "drop", "reason": "value 缺失"})
            continue
        unit = r.get("unit", "").strip().lower()
        v = float(r["value"])
        if unit == "mmhg":
            v = v * 0.133322
            LOG.append({"line": i, "action": "convert", "from": "mmHg", "to": "kPa"})
        r["value"] = v
        r["unit"] = "kPa"
        out.append(r)
    return out

if __name__ == "__main__":
    rows = list(csv.DictReader(open(sys.argv[1], newline="", encoding="utf-8")))
    cleaned = clean(rows)
    print(json.dumps({"cleaned": len(cleaned), "log": LOG}, ensure_ascii=False, indent=2))
`,
    },
  },

  'figure-studio': {
    title: '图版工坊',
    description: '按目标期刊的图注、字号、分辨率规范重排图表。',
    version: '1.0.3',
    tags: ['figure', 'typesetting'],
    files: {
      'SKILL.md': `---
name: figure-studio
description: 把图表整理成符合期刊投稿要求的成品图版。
version: 1.0.3
---

# 图版工坊

## 检查清单
- 位图 ≥ 300 dpi（线条图 ≥ 600 dpi）
- 字号：最终尺寸下 6–8 pt
- 面板标记统一大写粗体 A / B / C
- 图注自洽：读者不看正文也能看懂这张图
- 颜色不依赖红绿对比（色盲友好）
`,
    },
  },
};

/* ------------------------------------------------------------------ */
/* 落盘                                                               */
/* ------------------------------------------------------------------ */

function materialize(slug, def, targetDir) {
  for (const [rel, content] of Object.entries(def.files ?? {})) {
    const p = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) fs.writeFileSync(p, content, 'utf8');
  }
}

function skillDirFor(teamId, slug) {
  return path.join(SKILLS_DIR, teamId, slug);
}

/** 确保团队技能库落盘，返回 slug → 磁盘目录 */
export function ensureTeamSkills(teamId) {
  const dir = path.join(SKILLS_DIR, teamId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [slug, def] of Object.entries(BUILTIN)) {
    materialize(slug, def, path.join(dir, slug));
  }
  return dir;
}

/** 播种：把内置技能写进 db.skills（每个团队一份记录） */
export function seedSkillsForTeam(teamId, userId) {
  const db = db$();
  const existing = db.skills.filter((s) => s.teamId === teamId);
  const present = new Set(existing.map((s) => s.name));
  const ORDER = ['literature-review', 'prisma-flow', 'latex-manuscript', 'meta-analysis', 'data-cleaning', 'figure-studio'];
  for (const slug of ORDER) {
    if (present.has(slug)) continue;
    const def = BUILTIN[slug];
    db.skills.push({
      id: uuid(),
      teamId,
      userId,
      name: slug,
      slug,
      title: def.title,
      description: def.description,
      version: def.version,
      source: 'official',
      repo: 'https://github.com/clawsgo/skills',
      tags: def.tags,
      // 演示：「meta-analysis」默认未安装，其余已安装
      installed: slug !== 'meta-analysis',
      enabled: !['meta-analysis', 'figure-studio'].includes(slug),
      installedAt: slug === 'meta-analysis' ? null : now(),
      hostId: null,
      files: Object.keys(def.files ?? {}),
      readme: (def.files['SKILL.md'] ?? '').split('---').slice(2).join('---').trim() || def.description,
    });
  }
  save();
}

/* ------------------------------------------------------------------ */
/* 命令                                                               */
/* ------------------------------------------------------------------ */

function listSkills(teamId) {
  return db$()
    .skills.filter((s) => s.teamId === teamId)
    .map((s) => ({ ...skill(s), title: s.title ?? s.name, installed: s.installed !== false }));
}

async function getSkills(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  seedSkillsForTeam(teamId, ctx.user.id);
  ensureTeamSkills(teamId);
  const skills = listSkills(teamId);
  return { skills, items: skills, total: skills.length };
}

async function getSkillDetail(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  seedSkillsForTeam(teamId, ctx.user.id);
  const row = db$().skills.find((s) => s.teamId === teamId && (s.name === p?.slug || s.id === p?.slug));
  if (!row) notFound('技能');
  const dir = path.join(ensureTeamSkills(teamId), row.name);
  const files = [];
  const walk = (d, base = '') => {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d)) {
      const a = path.join(d, n);
      const rel = base ? `${base}/${n}` : n;
      if (fs.statSync(a).isDirectory()) walk(a, rel);
      else files.push({ path: rel, name: n, size: fs.statSync(a).size });
    }
  };
  walk(dir);
  const detail = {
    ...skill(row),
    title: row.title ?? row.name,
    slug: row.name,
    installed: row.installed !== false,
    dir,
    files,
    fileCount: files.length,
    readme: fs.existsSync(path.join(dir, 'SKILL.md'))
      ? fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
      : (row.readme ?? ''),
  };
  return { detail, skill: detail };
}

async function getSkillFile(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const slug = req(p, 'slug');
  const rel = String(p?.path ?? 'SKILL.md');
  const dir = path.join(ensureTeamSkills(teamId), slug);
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(path.resolve(dir))) throw badRequest('路径越界');
  if (!fs.existsSync(abs)) notFound('技能文件');

  if (fs.statSync(abs).isDirectory()) {
    const entries = fs.readdirSync(abs).map((n) => {
      const a = path.join(abs, n);
      return {
        name: n,
        path: [rel, n].filter((x) => x && x !== '.').join('/'),
        type: fs.statSync(a).isDirectory() ? 'dir' : 'file',
        size: fs.statSync(a).isDirectory() ? 0 : fs.statSync(a).size,
      };
    });
    return { exists: true, path: rel, type: 'dir', entries, content: null };
  }

  const content = fs.readFileSync(abs, 'utf8');
  return {
    exists: true,
    path: rel,
    type: 'file',
    content,
    text: content,
    size: Buffer.byteLength(content),
    language: path.extname(abs).replace('.', '') || 'markdown',
  };
}

async function installSkill(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const db = db$();
  let row = db.skills.find((s) => s.teamId === teamId && (s.name === p?.slug || s.name === p?.name));
  if (!row) {
    const slug = p?.slug ?? p?.name ?? req(p, 'slug');
    const def = BUILTIN[slug];
    if (!def) {
      // 未知技能：先落一个可用的最小技能，保证流程走得通
      materialize(slug, { files: { 'SKILL.md': `---\nname: ${slug}\ndescription: 用户安装的技能\nversion: 1.0.0\n---\n\n# ${slug}\n\n（本地复刻占位技能）\n` } }, path.join(ensureTeamSkills(teamId), slug));
    } else {
      materialize(slug, def, path.join(ensureTeamSkills(teamId), slug));
    }
    row = {
      id: uuid(),
      teamId,
      userId: ctx.user.id,
      name: slug,
      slug,
      title: def?.title ?? slug,
      description: def?.description ?? '用户安装的技能',
      version: def?.version ?? '1.0.0',
      source: p?.source ?? (def ? 'official' : 'manual'),
      tags: def?.tags ?? [],
      installed: true,
      enabled: true,
      installedAt: now(),
      hostId: null,
      files: Object.keys(def?.files ?? { 'SKILL.md': 1 }),
    };
    db.skills.push(row);
  } else {
    row.installed = true;
    row.enabled = true;
    row.installedAt = row.installedAt ?? now();
  }
  save();
  return { skill: skill(row), ok: true };
}

async function uninstallSkill(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const db = db$();
  const row = db.skills.find((s) => s.teamId === teamId && (s.name === p?.slug || s.id === p?.slug));
  if (!row) notFound('技能');
  row.installed = false;
  row.enabled = false;
  save();
  return { ok: true, skill: skill(row) };
}

async function setSkillEnabled(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const db = db$();
  const row = db.skills.find((s) => s.teamId === teamId && (s.name === p?.slug || s.id === p?.slug));
  if (!row) notFound('技能');
  const enabled = p?.enabled !== false;
  row.enabled = enabled;
  if (enabled) row.installed = true;
  save();
  return { ok: true, skill: skill(row) };
}

/** 技能市场：本地内置目录 + 简单匹配 */
async function searchSkillMarket(p, ctx) {
  const q = String(p?.query ?? '').trim().toLowerCase();
  const rows = Object.entries(BUILTIN)
    .filter(([slug, def]) => {
      if (q.length < 2) return false;
      return (
        slug.includes(q) ||
        def.title.toLowerCase().includes(q) ||
        def.description.toLowerCase().includes(q) ||
        (def.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    })
    .map(([slug, def]) => ({
      id: slug,
      slug,
      name: slug,
      title: def.title,
      description: def.description,
      version: def.version,
      source: 'official',
      repo: 'https://github.com/clawsgo/skills',
      tags: def.tags,
      fileCount: Object.keys(def.files ?? {}).length,
      stars: 120 + slug.length * 7,
      installs: 300 + slug.length * 13,
      installed: db$().skills.some((s) => s.teamId === (p?.teamId || ctx.teamId) && s.name === slug && s.installed !== false),
    }));
  return { skills: rows, items: rows, total: rows.length, query: p?.query ?? '' };
}

/** GitHub 技能：本地复刻不联网抓 GitHub，返回内置目录的可安装项 */
async function listGithubSkills(p, ctx) {
  const repo = p?.repo ?? 'clawsgo/skills';
  const rows = Object.entries(BUILTIN).map(([slug, def]) => ({
    slug,
    name: slug,
    title: def.title,
    description: def.description,
    version: def.version,
    path: `${slug}/SKILL.md`,
    repo,
    url: `https://github.com/${repo}/tree/main/${slug}`,
    fileCount: Object.keys(def.files ?? {}).length,
  }));
  return { skills: rows, items: rows, total: rows.length, repo };
}

async function installHostSkill(p, ctx) {
  const hostId = req(p, 'hostId');
  const teamId = p?.teamId || ctx.teamId;
  const db = db$();
  const slug = p?.slug ?? p?.name;
  const source = db.skills.find((s) => s.teamId === teamId && s.name === slug);
  if (!source) notFound('技能');
  let row = db.skills.find((s) => s.hostId === hostId && s.name === slug);
  if (!row) {
    row = { ...source, id: uuid(), hostId, teamId, installed: true, enabled: true, installedAt: now() };
    db.skills.push(row);
  } else {
    row.installed = true;
    row.enabled = true;
  }
  save();
  return { ok: true, skill: skill(row) };
}

async function uploadHostSkill(p, ctx) {
  const hostId = req(p, 'hostId');
  const teamId = p?.teamId || ctx.teamId;
  const db = db$();
  const raw = ctx.rawBody && ctx.rawBody.length ? ctx.rawBody.toString('utf8') : '';
  const slug = p?.slug ?? p?.name ?? `uploaded-${Date.now().toString(36)}`;
  const dir = path.join(ensureTeamSkills(teamId), slug);
  fs.mkdirSync(dir, { recursive: true });
  if (raw) fs.writeFileSync(path.join(dir, 'SKILL.md'), raw, 'utf8');
  const row = {
    id: uuid(),
    teamId,
    userId: ctx.user.id,
    name: slug,
    slug,
    title: p?.title ?? slug,
    description: p?.description ?? '上传的技能',
    version: '1.0.0',
    source: 'upload',
    tags: [],
    installed: true,
    enabled: true,
    installedAt: now(),
    hostId,
    files: ['SKILL.md'],
  };
  db.skills.push(row);
  save();
  return { ok: true, skill: skill(row), dir };
}

export const commands = {
  getSkills,
  getSkillDetail,
  getSkillFile,
  installSkill,
  uninstallSkill,
  setSkillEnabled,
  searchSkillMarket,
  listGithubSkills,
  installHostSkill,
  uploadHostSkill,
};
