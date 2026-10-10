import fs from 'node:fs';

const ASSETS = '/Users/cz/code/clawsgo-open/.live/app/assets';
const OUT = '/Users/cz/code/clawsgo-open/work/deep-reverse';
fs.mkdirSync(OUT, { recursive: true });

function readChunk(name) {
  try { return fs.readFileSync(`${ASSETS}/${name}`, 'utf8'); }
  catch { return ''; }
}

// ===================== 1. 从所有 chunks 提取完整的 API 命令引用 =====================
function extractAllCommands() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js'));
  const allRefs = new Map();
  
  // 已知的命令前缀模式
  const knownPrefixes = [
    'get', 'set', 'create', 'update', 'delete', 'remove', 'send', 'stop',
    'admin', 'search', 'list', 'upload', 'download', 'attach', 'detach',
    'archive', 'unarchive', 'share', 'unshare', 'mark', 'quote', 'sync',
    'probe', 'pick', 'redeem', 'claim', 'apply', 'void', 'issue', 'refund',
    'grant', 'revoke', 'register', 'prepare', 'rebuild', 'clean', 'reorder',
    'accept', 'reject', 'invite', 'join', 'leave', 'switch', 'toggle',
    'start', 'pause', 'resume', 'cancel', 'retry', 'answer', 'request',
    'generate', 'convert', 'export', 'import', 'install', 'uninstall',
    'enable', 'disable', 'open', 'close', 'read', 'write', 'copy', 'move',
    'rename', 'validate', 'verify', 'check', 'test', 'debug', 'run',
    'migrate', 'settle', 'recall', 'promote', 'demote'
  ];
  
  for (const file of files) {
    const src = readChunk(file);
    // 模式: `cmdName` 作为字符串字面量后跟逗号或右括号
    const matches = [...src.matchAll(/[`"']([a-z][a-zA-Z0-9_\/]{3,50})[`"']\s*[,)]/g)];
    for (const m of matches) {
      const cmd = m[1];
      // 过滤：必须是合理的命令名
      if (cmd.includes('react') || cmd.includes('jsx') || cmd.includes('runtime') ||
          cmd.includes('module') || cmd.startsWith('data') || cmd.startsWith('http') ||
          cmd.includes('function') || cmd.includes('return') || cmd.includes('typeof') ||
          cmd.includes('undefined') || cmd.includes('window') || cmd.includes('document') ||
          cmd.includes('console') || cmd.includes('error') || cmd.includes('string') ||
          cmd.includes('number') || cmd.includes('boolean') || cmd.includes('object') ||
          cmd.includes('array') || cmd.includes('null') || cmd.includes('true') ||
          cmd.includes('false') || cmd.includes('async') || cmd.includes('await') ||
          cmd.includes('import') || cmd.includes('export') || cmd.includes('default') ||
          cmd.includes('static') || cmd.includes('public') || cmd.includes('private') ||
          cmd.includes('protected') || cmd.includes('class') || cmd.includes('interface') ||
          cmd.includes('extends') || cmd.includes('implements') || cmd.includes('super') ||
          cmd.includes('this') || cmd.includes('new') || cmd.includes('delete') ||
          cmd.includes('instanceof') || cmd.includes('in') || cmd.includes('of') ||
          cmd.includes('for') || cmd.includes('while') || cmd.includes('do') ||
          cmd.includes('if') || cmd.includes('else') || cmd.includes('switch') ||
          cmd.includes('case') || cmd.includes('break') || cmd.includes('continue') ||
          cmd.includes('try') || cmd.includes('catch') || cmd.includes('finally') ||
          cmd.includes('throw') || cmd.includes('yield') || cmd.includes('void') ||
          cmd.includes('with') || cmd.includes('debugger') || cmd.includes('const') ||
          cmd.includes('let') || cmd.includes('var') || cmd.includes('from') ||
          cmd.includes('as') || cmd.includes('type') || cmd.includes('enum') ||
          cmd.includes('namespace') || cmd.includes('declare') || cmd.includes('abstract') ||
          cmd.includes('readonly') || cmd.includes('optional') || cmd.includes('required') ||
          cmd.includes('any') || cmd.includes('unknown') || cmd.includes('never') ||
          cmd.includes('symbol') || cmd.includes('bigint') || cmd.includes('map') ||
          cmd.includes('set') || cmd.includes('weakmap') || cmd.includes('weakset') ||
          cmd.includes('promise') || cmd.includes('proxy') || cmd.includes('reflect') ||
          cmd.includes('json') || cmd.includes('math') || cmd.includes('date') ||
          cmd.includes('regexp') || cmd.includes('error') || cmd.includes('eval') ||
          cmd.includes('parse') || cmd.includes('encode') || cmd.includes('decode') ||
          cmd.includes('escape') || cmd.includes('unescape') || cmd.includes('is') ||
          cmd.includes('has') || cmd.includes('get') && cmd.length < 6 ||
          cmd.includes('set') && cmd.length < 6 ||
          cmd.includes('to') && cmd.length < 5 ||
          cmd.includes('of') && cmd.length < 5 ||
          cmd.includes('at') && cmd.length < 5 ||
          cmd.includes('on') && cmd.length < 5 ||
          cmd.includes('by') && cmd.length < 5 ||
          cmd.includes('in') && cmd.length < 5 ||
          cmd.length < 4 || cmd.length > 50) continue;
      
      // 检查是否以已知前缀开头
      const hasPrefix = knownPrefixes.some(p => cmd.startsWith(p));
      if (!hasPrefix) continue;
      
      if (!allRefs.has(cmd)) allRefs.set(cmd, []);
      if (allRefs.get(cmd).length < 3) allRefs.get(cmd).push(file);
    }
  }
  
  console.log('=== ALL API COMMANDS (from all chunks) ===');
  const sorted = [...allRefs.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [cmd, files] of sorted.slice(0, 150)) {
    console.log(`  ${cmd} [${files.join(', ')}]`);
  }
  fs.writeFileSync(`${OUT}/all-commands.json`, JSON.stringify(Object.fromEntries(sorted.slice(0, 300)), null, 2));
  return sorted;
}

// ===================== 2. 提取模型/模式配置 =====================
function extractModels() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js'));
  const models = new Set();
  const modes = new Set();
  
  for (const file of files) {
    const src = readChunk(file);
    // 找 modelId 相关
    const m1 = [...src.matchAll(/modelId[:\s]*[`"']([^`"']+)[`"']/g)];
    m1.forEach(m => models.add(m[1]));
    
    // 找 mode 相关
    const m2 = [...src.matchAll(/mode[:\s]*[`"']([a-z]+)[`"']/g)];
    m2.forEach(m => modes.add(m[1]));
  }
  
  console.log('\n=== MODEL IDs ===');
  for (const m of [...models].sort()) console.log(' ', m);
  
  console.log('\n=== MODES ===');
  for (const m of [...modes].sort()) console.log(' ', m);
  
  fs.writeFileSync(`${OUT}/models.json`, JSON.stringify([...models].sort(), null, 2));
  fs.writeFileSync(`${OUT}/modes.json`, JSON.stringify([...modes].sort(), null, 2));
}

// ===================== 3. 提取角色/权限系统 =====================
function extractRoles() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js'));
  const roles = new Set();
  const permissions = new Set();
  
  for (const file of files) {
    const src = readChunk(file);
    // 角色
    const m1 = [...src.matchAll(/role[:\s]*[`"']([a-z_]+)[`"']/g)];
    m1.forEach(m => roles.add(m[1]));
    
    // 权限
    const m2 = [...src.matchAll(/permission[:\s]*[`"']([a-z_]+)[`"']/g)];
    m2.forEach(m => permissions.add(m[1]));
  }
  
  console.log('\n=== ROLES ===');
  for (const r of [...roles].sort()) console.log(' ', r);
  
  console.log('\n=== PERMISSIONS ===');
  for (const p of [...permissions].sort()) console.log(' ', p);
  
  fs.writeFileSync(`${OUT}/roles.json`, JSON.stringify([...roles].sort(), null, 2));
  fs.writeFileSync(`${OUT}/permissions.json`, JSON.stringify([...permissions].sort(), null, 2));
}

// ===================== 4. 提取错误码 =====================
function extractErrorCodes() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js'));
  const codes = new Set();
  
  for (const file of files) {
    const src = readChunk(file);
    // 找 ERROR 或 code:`XXX` 模式
    const m1 = [...src.matchAll(/code[:\s]*[`"']([A-Z_][A-Z_0-9]*)[`"']/g)];
    m1.forEach(m => codes.add(m[1]));
  }
  
  console.log('\n=== ERROR CODES ===');
  for (const c of [...codes].sort()) console.log(' ', c);
  fs.writeFileSync(`${OUT}/error-codes.json`, JSON.stringify([...codes].sort(), null, 2));
}

// ===================== 5. 提取文件类型/MIME =====================
function extractFileTypes() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js'));
  const types = new Set();
  
  for (const file of files) {
    const src = readChunk(file);
    const m1 = [...src.matchAll(/type[:\s]*[`"']([a-z][a-z0-9_\/-]*)[`"']/g)];
    m1.forEach(m => types.add(m[1]));
  }
  
  console.log('\n=== FILE TYPES ===');
  for (const t of [...types].sort().slice(0, 50)) console.log(' ', t);
}

// ===================== 6. 提取消息 part 类型 =====================
function extractMessagePartTypes() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js'));
  const parts = new Set();
  
  for (const file of files) {
    const src = readChunk(file);
    // 找 part 类型
    const m1 = [...src.matchAll(/type[:\s]*[`"'](text|reasoning|tool|image|file|error|agent|agents|track)[`"']/g)];
    m1.forEach(m => parts.add(m[1]));
  }
  
  console.log('\n=== MESSAGE PART TYPES ===');
  for (const p of [...parts].sort()) console.log(' ', p);
  fs.writeFileSync(`${OUT}/part-types.json`, JSON.stringify([...parts].sort(), null, 2));
}

// ===================== 7. 提取主机状态 =====================
function extractHostStates() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js'));
  const states = new Set();
  
  for (const file of files) {
    const src = readChunk(file);
    const m1 = [...src.matchAll(/[`"'](provisioning|running|offline|stopped|sleeping|waking|failed|error)[`"']/g)];
    m1.forEach(m => states.add(m[1]));
  }
  
  console.log('\n=== HOST STATES ===');
  for (const s of [...states].sort()) console.log(' ', s);
}

// ===================== 8. 提取卡类型 =====================
function extractCardTypes() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js'));
  const types = new Set();
  const statuses = new Set();
  
  for (const file of files) {
    const src = readChunk(file);
    const m1 = [...src.matchAll(/cardType[:\s]*[`"']([a-z]+)[`"']/g)];
    m1.forEach(m => types.add(m[1]));
    const m2 = [...src.matchAll(/status[:\s]*[`"'](active|used|expired|voided)[`"']/g)];
    m2.forEach(m => statuses.add(m[1]));
  }
  
  console.log('\n=== CARD TYPES ===');
  for (const t of [...types].sort()) console.log(' ', t);
  console.log('\n=== CARD STATUSES ===');
  for (const s of [...statuses].sort()) console.log(' ', s);
}

// ===================== 执行 =====================
console.log('=== DEEP REVERSE ANALYSIS (Phase 2) ===');
console.log('');

extractAllCommands();
extractModels();
extractRoles();
extractErrorCodes();
extractFileTypes();
extractMessagePartTypes();
extractHostStates();
extractCardTypes();

console.log('\n=== DONE ===');
