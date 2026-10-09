/**
 * server/lib/reset.mjs —— 开发/测试用的「恢复到出厂状态」
 * ------------------------------------------------------------------
 * 复刻项目里所有有状态的东西都落在磁盘上（db.json、每个会话的工作区目录、
 * 每台主机的主机盘、技能库文件），所以「重跑一遍验收」必须先把它们清干净，
 * 否则上一轮的产物会让这一轮撞上 409 / 重复数据 —— e2e 就不是可重复的了。
 *
 * 这里做四件事：
 *   1. 清掉磁盘上的派生态（hosts/ workspace/ files/），技能库保留（纯内容，可复用）
 *   2. 内存 DB 归一为空库并落盘
 *   3. 重新播种演示数据
 *   4. 重建每个团队的技能记录并确保技能文件已落盘
 *
 * 只在非生产环境可用（见 serve.mjs 的 /__reset 守卫）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, db$, reset, flush } from './db.mjs';
import { seedIfEmpty } from './seed.mjs';

/** 需要清空的派生目录（相对于 server/data） */
const DERIVED_DIRS = ['hosts', 'workspace', 'files', 'images'];

function wipeDir(abs) {
  try {
    fs.rmSync(abs, { recursive: true, force: true });
  } catch {
    /* 忽略：清不掉也不该让重置失败，后续 mkdir 会重建 */
  }
  fs.mkdirSync(abs, { recursive: true });
}

/**
 * 恢复出厂状态。
 * @param {(teamId: string, userId: string) => void} reseedSkills 由调用方注入，避免循环依赖
 * @returns {{ok: true, wiped: string[], seeded: boolean, teams: number}}
 */
export function resetAll({ reseedSkills, ensureSkills } = {}) {
  const wiped = [];
  for (const d of DERIVED_DIRS) {
    wipeDir(path.join(DATA_DIR, d));
    wiped.push(d);
  }

  // 内存 + 磁盘同时归零，然后重新播种
  reset();
  const seeded = seedIfEmpty();

  const db = db$();
  const teams = db.teams.length;
  if (typeof reseedSkills === 'function') {
    for (const t of db.teams) reseedSkills(t.id, t.ownerId);
  }
  if (typeof ensureSkills === 'function') {
    for (const t of db.teams) ensureSkills(t.id);
  }
  flush();

  return { ok: true, wiped, seeded, teams, dbFile: path.join(DATA_DIR, 'db.json') };
}
