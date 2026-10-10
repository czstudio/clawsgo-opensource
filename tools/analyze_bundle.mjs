import fs from 'node:fs';

const ASSETS = '/Users/cz/code/clawsgo-open/.live/app/assets';

function readChunk(name) {
  return fs.readFileSync(`${ASSETS}/${name}`, 'utf8');
}

// 1. 分析 API 客户端 - 提取所有命令名
function analyzeApi() {
  const src = readChunk('api-DYG_whnY.js');
  // 查找模式: `cmdName` 或 "cmdName" 出现在 API 调用中
  const cmdMatches = [...src.matchAll(/[`"']([a-z][a-zA-Z0-9_\/]*)[`"']/g)];
  const cmds = new Set();
  for (const m of cmdMatches) {
    const s = m[1];
    // 过滤掉明显的非命令字符串
    if (s.length > 2 && s.length < 60 && 
        !s.includes('react') && !s.includes('jsx') && 
        !s.includes('runtime') && !s.includes('module') &&
        !s.startsWith('data') && !s.startsWith('http') &&
        /[a-z]/.test(s[0]) && !/^[a-z]$/.test(s)) {
      cmds.add(s);
    }
  }
  console.log('=== API CLIENT COMMANDS ===');
  const sorted = [...cmds].sort();
  for (const c of sorted) console.log('  ', c);
  console.log(`Total: ${sorted.length}`);
  return sorted;
}

// 2. 分析路由
function analyzeRoutes() {
  const src = readChunk('index-QbJOivX-.js');
  // 查找路由模式: path:"/xxx" 或 path:'/xxx'
  const routeMatches = [...src.matchAll(/path[:\s]*[`"'](\/[^`"']*)[`"']/g)];
  const routes = new Set();
  for (const m of routeMatches) routes.add(m[1]);
  console.log('\n=== ROUTES ===');
  for (const r of [...routes].sort()) console.log('  ', r);
  console.log(`Total: ${routes.size}`);
  return [...routes];
}

// 3. 分析 SSE 事件类型
function analyzeSSE() {
  const src = readChunk('useConversationStream-Bfce93ac.js');
  const eventMatches = [...src.matchAll(/t[:\s]*[`"']([a-z-]+)[`"']/g)];
  const events = new Set();
  for (const m of eventMatches) events.add(m[1]);
  console.log('\n=== SSE EVENT TYPES ===');
  for (const e of [...events].sort()) console.log('  ', e);
  console.log(`Total: ${events.size}`);
  return [...events];
}

// 4. 分析 Store / 状态管理 key
function analyzeStore() {
  const src = readChunk('store-BoRZvorU.js');
  const keyMatches = [...src.matchAll(/[`"']([a-zA-Z][a-zA-Z0-9_-]*)[`"']/g)];
  const keys = new Set();
  for (const m of keyMatches) {
    const s = m[1];
    if (s.length > 2 && s.length < 40 && !s.includes('react') && !s.includes('jsx')) {
      keys.add(s);
    }
  }
  console.log('\n=== STORE KEYS ===');
  for (const k of [...keys].sort().slice(0, 50)) console.log('  ', k);
  console.log(`Total: ${keys.size}`);
}

// 5. 分析 Shell / 终端协议
function analyzeShell() {
  const src = readChunk('_shell-DLMlr5Wy.js');
  const msgMatches = [...src.matchAll(/t[:\s]*[`"']([a-z_]+)[`"']/g)];
  const msgs = new Set();
  for (const m of msgMatches) msgs.add(m[1]);
  console.log('\n=== SHELL MESSAGE TYPES ===');
  for (const m of [...msgs].sort()) console.log('  ', m);
  console.log(`Total: ${msgs.size}`);
}

// 6. 分析所有 chunks 中的命令引用
function findAllCommandReferences() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js') && f.length < 60);
  const allCmds = new Map();
  
  for (const file of files) {
    const src = fs.readFileSync(`${ASSETS}/${file}`, 'utf8');
    // 查找 api(cmd, ...) 或 Q(cmd, ...) 模式
    const refs = [...src.matchAll(/\b([a-z][a-zA-Z0-9_\/]{3,50})\b/g)];
    for (const m of refs) {
      const cmd = m[1];
      if (!allCmds.has(cmd)) allCmds.set(cmd, []);
      if (allCmds.get(cmd).length < 3) allCmds.get(cmd).push(file);
    }
  }
  
  // 过滤：只保留在 api-DYG_whnY.js 中也被引用的（这些是真实命令）
  const apiSrc = readChunk('api-DYG_whnY.js');
  const realCmds = [];
  for (const [cmd, files] of allCmds) {
    if (apiSrc.includes(cmd) && cmd.length > 3 && cmd.length < 50) {
      realCmds.push({ cmd, files });
    }
  }
  
  console.log('\n=== COMMAND REFERENCES (top 100) ===');
  realCmds.sort((a, b) => b.files.length - a.files.length);
  for (const { cmd, files } of realCmds.slice(0, 100)) {
    console.log(`  ${cmd} [${files.join(', ')}]`);
  }
}

// 执行
const cmds = analyzeApi();
analyzeRoutes();
analyzeSSE();
analyzeStore();
analyzeShell();
findAllCommandReferences();
