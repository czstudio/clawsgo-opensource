import fs from 'node:fs';

const ASSETS = '/Users/cz/code/clawsgo-open/.live/app/assets';
const OUT = '/Users/cz/code/clawsgo-open/work/deep-reverse';
fs.mkdirSync(OUT, { recursive: true });

function readChunk(name) {
  try { return fs.readFileSync(`${ASSETS}/${name}`, 'utf8'); }
  catch { return ''; }
}

// ===================== 1. SSE 事件类型完整提取 =====================
function extractSSEEvents() {
  const src = readChunk('useConversationStream-Bfce93ac.js');
  // 找 n.t===`xxx` 模式
  const matches = [...src.matchAll(/t===[`"']([a-z-]+)[`"']/g)];
  const events = new Set(matches.map(m => m[1]));
  
  // 也找 e.t===`xxx` 等变体
  const matches2 = [...src.matchAll(/\.t===[`"']([a-z-]+)[`"']/g)];
  matches2.forEach(m => events.add(m[1]));
  
  console.log('=== SSE EVENT TYPES ===');
  for (const e of [...events].sort()) console.log(' ', e);
  fs.writeFileSync(`${OUT}/sse-events.json`, JSON.stringify([...events].sort(), null, 2));
  return [...events];
}

// ===================== 2. API 命令提取（从 api client + 所有引用处）=====================
function extractCommands() {
  // api client 中的命令名通常在 `post("cmdName"` 或 `Q("cmdName"` 模式中
  const apiSrc = readChunk('api-DYG_whnY.js');
  
  // 模式1: post(`cmdName`,{...})
  const m1 = [...apiSrc.matchAll(/post\([`"']([a-zA-Z][a-zA-Z0-9_\/]*)[`"']/g)];
  // 模式2: 直接字符串作为命令参数
  const m2 = [...apiSrc.matchAll(/[a-z]\([`"']([a-z][a-zA-Z0-9_\/]{2,40})[`"']\s*,/g)];
  
  const cmds = new Set();
  [...m1, ...m2].forEach(m => cmds.add(m[1]));
  
  // 过滤掉非命令的字符串
  const filtered = [...cmds].filter(c => 
    !c.includes('react') && !c.includes('jsx') && !c.includes('runtime') &&
    !c.includes('module') && !c.startsWith('data') && !c.startsWith('http') &&
    c.length > 2 && c.length < 50 && /^[a-z]/.test(c) &&
    !['function', 'return', 'typeof', 'undefined', 'boolean', 'string', 'number', 'object', 'array', 'null', 'true', 'false', 'Error', 'Promise', 'JSON', 'Math', 'Date', 'console', 'window', 'document', 'global', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'addEventListener', 'removeEventListener', 'localStorage', 'sessionStorage', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval', 'alert', 'confirm', 'prompt', 'open', 'close', 'print', 'postMessage', 'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask', 'structuredClone', 'crypto', 'navigator', 'location', 'history', 'screen', 'performance', 'indexedDB', 'webkitStorageInfo', 'webkitIndexedDB', 'chrome', 'safari', 'opr', 'opera', 'mozInnerScreenX', 'mozInnerScreenY'].includes(c)
  );
  
  console.log('\n=== API COMMANDS (from api client) ===');
  for (const c of filtered.sort()) console.log(' ', c);
  fs.writeFileSync(`${OUT}/api-commands.json`, JSON.stringify(filtered.sort(), null, 2));
  return filtered;
}

// ===================== 3. 路由提取（从 index.js）=====================
function extractRoutes() {
  const src = readChunk('index-QbJOivX-.js');
  
  // 找 TanStack Router 的路由定义
  // 模式: path:"/xxx" 或 path:'/xxx'
  const m1 = [...src.matchAll(/path[:\s]*[`"'](\/[^`"'{]*)[`"']/g)];
  const routes = new Set(m1.map(m => m[1]));
  
  // 也找 component 懒加载引用
  const m2 = [...src.matchAll(/component:\s*\(\)\s*=>\s*import\([`"']\.\/([^`"']*)[`"']/g)];
  const lazyComponents = m2.map(m => m[1]);
  
  console.log('\n=== ROUTES ===');
  for (const r of [...routes].sort()) console.log(' ', r);
  
  console.log('\n=== LAZY COMPONENTS ===');
  for (const c of lazyComponents.slice(0, 30)) console.log(' ', c);
  
  fs.writeFileSync(`${OUT}/routes.json`, JSON.stringify([...routes].sort(), null, 2));
  fs.writeFileSync(`${OUT}/lazy-components.json`, JSON.stringify(lazyComponents, null, 2));
  return { routes: [...routes], lazyComponents };
}

// ===================== 4. 从所有 chunks 提取 queryKey（React Query）=====================
function extractQueryKeys() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js'));
  const keys = new Map(); // key -> [files]
  
  for (const file of files) {
    const src = readChunk(file);
    // 找 queryKey:[`xxx`] 或 queryKey:["xxx"] 模式
    const matches = [...src.matchAll(/queryKey[:\s]*\[[`"']([^`"']+)[`"']/g)];
    for (const m of matches) {
      const k = m[1];
      if (!keys.has(k)) keys.set(k, []);
      if (keys.get(k).length < 3) keys.get(k).push(file);
    }
  }
  
  console.log('\n=== QUERY KEYS (React Query) ===');
  const sorted = [...keys.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [k, files] of sorted.slice(0, 50)) {
    console.log(`  ${k} [${files.join(', ')}]`);
  }
  fs.writeFileSync(`${OUT}/query-keys.json`, JSON.stringify(Object.fromEntries(sorted.slice(0, 100)), null, 2));
  return sorted;
}

// ===================== 5. 从所有 chunks 提取 mutationFn（React Query mutations）=====================
function extractMutations() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js'));
  const mutations = new Map();
  
  for (const file of files) {
    const src = readChunk(file);
    // 找 mutationFn:()=>t(`cmdName`) 模式
    const matches = [...src.matchAll(/mutationFn.*?\(\)\s*=>\s*[a-z]\([`"']([a-z][a-zA-Z0-9_]*)[`"']/g)];
    for (const m of matches) {
      const cmd = m[1];
      if (!mutations.has(cmd)) mutations.set(cmd, []);
      if (mutations.get(cmd).length < 3) mutations.get(cmd).push(file);
    }
  }
  
  console.log('\n=== MUTATIONS ===');
  const sorted = [...mutations.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [cmd, files] of sorted.slice(0, 50)) {
    console.log(`  ${cmd} [${files.join(', ')}]`);
  }
  fs.writeFileSync(`${OUT}/mutations.json`, JSON.stringify(Object.fromEntries(sorted.slice(0, 100)), null, 2));
  return sorted;
}

// ===================== 6. 提取 localStorage/sessionStorage keys =====================
function extractStorageKeys() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js'));
  const keys = new Set();
  
  for (const file of files) {
    const src = readChunk(file);
    // 找 getItem/setItem/removeItem 使用的 key
    const matches = [...src.matchAll(/[gs]etItem\([`"']([^`"']+)[`"']/g)];
    matches.forEach(m => keys.add(m[1]));
    const matches2 = [...src.matchAll(/removeItem\([`"']([^`"']+)[`"']/g)];
    matches2.forEach(m => keys.add(m[1]));
  }
  
  console.log('\n=== STORAGE KEYS ===');
  for (const k of [...keys].sort()) console.log(' ', k);
  fs.writeFileSync(`${OUT}/storage-keys.json`, JSON.stringify([...keys].sort(), null, 2));
  return [...keys];
}

// ===================== 7. 提取所有 chunk 中的字符串字面量（中文/英文 UI 文本）=====================
function extractUIText() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js') && f.length < 50);
  const texts = new Map();
  
  for (const file of files) {
    const src = readChunk(file);
    // 找中文字符串
    const cnMatches = [...src.matchAll(/[`"']([^`"']*[\u4e00-\u9fff]+[^`"']*)[`"']/g)];
    for (const m of cnMatches) {
      const t = m[1];
      if (t.length > 2 && t.length < 100) {
        if (!texts.has(t)) texts.set(t, []);
        if (texts.get(t).length < 2) texts.get(t).push(file);
      }
    }
  }
  
  console.log('\n=== UI TEXTS (Chinese, top 50) ===');
  const sorted = [...texts.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [t, files] of sorted.slice(0, 50)) {
    console.log(`  "${t}" [${files.join(', ')}]`);
  }
  fs.writeFileSync(`${OUT}/ui-texts-cn.json`, JSON.stringify(Object.fromEntries(sorted.slice(0, 200)), null, 2));
  return sorted;
}

// ===================== 8. 分析特定功能 chunks =====================
function analyzeFeatureChunks() {
  const features = {
    'imageGen': 'imageGen-Bxp0L2A6.js',
    'hosts': 'hosts-Bn4J1VDx.js',
    'cards': 'cards-C_4k5wOQ.js',
    'skills': 'skills-B6guTVGj.js',
    'shell': '_shell-DLMlr5Wy.js',
    'chat': 'chat-BN-3UkXe.js',
    'admin_hosts': 'admin_hosts_title-DMZZMiWO.js',
  };
  
  for (const [name, file] of Object.entries(features)) {
    const src = readChunk(file);
    if (!src) continue;
    
    // 提取这个 chunk 中引用的命令
    const cmdMatches = [...src.matchAll(/[a-z]\([`"']([a-z][a-zA-Z0-9_\/]{3,40})[`"']\s*,/g)];
    const cmds = new Set(cmdMatches.map(m => m[1]));
    
    console.log(`\n=== ${name.toUpperCase()} COMMANDS ===`);
    for (const c of [...cmds].sort().slice(0, 30)) console.log(' ', c);
    
    fs.writeFileSync(`${OUT}/${name}-commands.json`, JSON.stringify([...cmds].sort(), null, 2));
  }
}

// ===================== 执行 =====================
console.log('=== DEEP REVERSE ANALYSIS ===');
console.log('Target:', ASSETS);
console.log('');

const sseEvents = extractSSEEvents();
const commands = extractCommands();
const routes = extractRoutes();
const queryKeys = extractQueryKeys();
const mutations = extractMutations();
const storageKeys = extractStorageKeys();
const uiTexts = extractUIText();
analyzeFeatureChunks();

// 汇总报告
const report = {
  sseEvents,
  commandCount: commands.length,
  routeCount: routes.routes.length,
  lazyComponentCount: routes.lazyComponents.length,
  queryKeyCount: queryKeys.length,
  mutationCount: mutations.length,
  storageKeyCount: storageKeys.length,
  uiTextCount: uiTexts.length,
};

fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(report, null, 2));
console.log('\n=== SUMMARY ===');
console.log(JSON.stringify(report, null, 2));
