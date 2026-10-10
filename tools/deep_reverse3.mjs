import fs from 'node:fs';

const ASSETS = '/Users/cz/code/clawsgo-open/.live/app/assets';
const OUT = '/Users/cz/code/clawsgo-open/work/deep-reverse';

function readChunk(name) {
  try { return fs.readFileSync(`${ASSETS}/${name}`, 'utf8'); }
  catch { return ''; }
}

// 第三方库文件列表（排除这些）
const THIRD_PARTY = ['mermaid', 'cytoscape', 'monaco', 'katex', 'jspdf', 'react', 'react-dom', 
  'jsx-runtime', 'rolldown-runtime', 'editor.api', 'chunk-', 'diagram-', 'sequenceDiagram',
  'blockDiagram', 'c4Diagram', 'ganttDiagram', 'journeyDiagram', 'quadrantDiagram', 
  'timeline-definition', 'architectureDiagram', 'gitGraphDiagram', 'swimlanes', 'wardleyDiagram',
  'pdf-', ' openscad', 'marko', 'erlang', 'haskell', 'webidl', 'tsMode', 'powerquery',
  'vb-', 'cytoscape', 'MeshViewer', 'MoleculeViewer', 'VolumeViewer', 'animate', 'ball-and-stick',
  'carbohydrate', 'cartoon', 'ribbon', 'surface', 'trace', 'tube'];

function isThirdParty(file) {
  return THIRD_PARTY.some(t => file.includes(t));
}

// ===================== 1. 精确提取业务命令 =====================
function extractBusinessCommands() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js') && !isThirdParty(f));
  const commands = new Map();
  
  // 业务命令特征：在 api client 调用中出现
  // 模式: t(`cmdName`,{...}) 或 api(`cmdName`,...)
  for (const file of files) {
    const src = readChunk(file);
    
    // 模式1: 函数调用中的字符串参数
    const matches = [...src.matchAll(/\b[a-z][a-zA-Z0-9_$]*\([`"']([a-z][a-zA-Z0-9_\/]{4,45})[`"']\s*,/g)];
    for (const m of matches) {
      const cmd = m[1];
      // 严格过滤
      if (/^(get|set|create|update|delete|remove|send|stop|start|pause|resume|cancel|retry|answer|request|generate|convert|export|import|install|uninstall|enable|disable|open|close|read|write|copy|move|rename|validate|verify|check|test|run|migrate|settle|recall|promote|demote|archive|unarchive|share|unshare|mark|quote|sync|probe|pick|redeem|claim|apply|void|issue|refund|grant|revoke|register|prepare|rebuild|clean|reorder|accept|reject|invite|join|leave|switch|toggle|attach|detach|upload|download|search|list|admin)/.test(cmd)) {
        if (!commands.has(cmd)) commands.set(cmd, []);
        if (commands.get(cmd).length < 3) commands.get(cmd).push(file);
      }
    }
  }
  
  console.log('=== BUSINESS COMMANDS ===');
  const sorted = [...commands.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [cmd, files] of sorted.slice(0, 100)) {
    console.log(`  ${cmd} [${files.join(', ')}]`);
  }
  fs.writeFileSync(`${OUT}/business-commands.json`, JSON.stringify(Object.fromEntries(sorted.slice(0, 200)), null, 2));
  return sorted;
}

// ===================== 2. 提取 sendMessage 参数结构 =====================
function extractSendMessageStructure() {
  const src = readChunk('api-DYG_whnY.js');
  
  // 找 sendMessage 调用点
  const idx = src.indexOf('sendMessage');
  if (idx < 0) return;
  
  const context = src.slice(Math.max(0, idx - 500), idx + 1500);
  console.log('\n=== SENDMESSAGE CONTEXT ===');
  console.log(context.slice(0, 2000));
  fs.writeFileSync(`${OUT}/sendMessage-context.txt`, context);
}

// ===================== 3. 提取模型配置 =====================
function extractModelConfig() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js') && !isThirdParty(f));
  const models = new Map();
  
  for (const file of files) {
    const src = readChunk(file);
    // 找 model 配置对象
    const m1 = [...src.matchAll(/[`"'](clawsgo-[0-9.]+-[a-z]+)[`"']/g)];
    for (const m of m1) {
      const model = m[1];
      if (!models.has(model)) models.set(model, []);
      if (models.get(model).length < 3) models.get(model).push(file);
    }
    
    // 找底层模型名
    const m2 = [...src.matchAll(/[`"'](deepseek|claude|gpt|glm)-[a-z0-9-]+[`"']/g)];
    for (const m of m2) {
      const model = m[1];
      if (!models.has(model)) models.set(model, []);
      if (models.get(model).length < 3) models.get(model).push(file);
    }
  }
  
  console.log('\n=== MODEL REFERENCES ===');
  for (const [model, files] of [...models.entries()].sort()) {
    console.log(`  ${model} [${files.join(', ')}]`);
  }
}

// ===================== 4. 提取图片生成配置 =====================
function extractImageGenConfig() {
  const src = readChunk('imageGen-Bxp0L2A6.js');
  if (!src) return;
  
  // 找 aspect ratio 配置
  const ratios = [...src.matchAll(/[`"'](auto|1:1|16:9|9:16|square|wide|portrait)[`"']/g)];
  const uniqueRatios = new Set(ratios.map(m => m[1]));
  
  console.log('\n=== IMAGE ASPECT RATIOS ===');
  for (const r of [...uniqueRatios].sort()) console.log(' ', r);
  
  // 找 style/prompt 相关
  const styles = [...src.matchAll(/[`"']([a-z]+)[`"']\s*:\s*[`"']([^`"']+)[`"']/g)];
  console.log('\n=== IMAGE STYLES ===');
  for (const m of styles.slice(0, 20)) {
    console.log(`  ${m[1]}: ${m[2]}`);
  }
  
  fs.writeFileSync(`${OUT}/imageGen-config.json`, JSON.stringify({
    ratios: [...uniqueRatios],
    styles: styles.slice(0, 30).map(m => ({ key: m[1], value: m[2] }))
  }, null, 2));
}

// ===================== 5. 提取主机/云主机配置 =====================
function extractHostConfig() {
  const src = readChunk('hosts-Bn4J1VDx.js');
  if (!src) return;
  
  const specs = [...src.matchAll(/[`"']([a-z][a-zA-Z0-9_]*)[`"']\s*:\s*([0-9]+)/g)];
  console.log('\n=== HOST SPECS ===');
  for (const m of specs.slice(0, 30)) {
    console.log(`  ${m[1]}: ${m[2]}`);
  }
}

// ===================== 6. 提取计费/套餐配置 =====================
function extractBillingConfig() {
  const src = readChunk('billing-Bitt_SRn.js');
  
  // 找 plan 名称
  const plans = [...src.matchAll(/[`"'](free|plus|pro|ultra|team|enterprise)[`"']/g)];
  const uniquePlans = new Set(plans.map(m => m[1]));
  
  console.log('\n=== BILLING PLANS ===');
  for (const p of [...uniquePlans].sort()) console.log(' ', p);
  
  // 找货币相关
  const currencies = [...src.matchAll(/[`"'](CNY|USD|¥|\$)[`"']/g)];
  console.log('\n=== CURRENCIES ===');
  for (const c of [...new Set(currencies.map(m => m[1]))].sort()) console.log(' ', c);
}

// ===================== 7. 提取 auth 流程 =====================
function extractAuthFlow() {
  const src = readChunk('api-DYG_whnY.js');
  
  // 找 token 处理
  const tokenMatches = [...src.matchAll(/(auth-token|token|Authorization|Bearer|set-auth-token)/g)];
  console.log('\n=== AUTH TOKENS ===');
  console.log(`  Found ${tokenMatches.length} token references`);
  
  // 找登录相关命令
  const loginCmds = [...src.matchAll(/[`"'](phone-number\/[a-z-]+)[`"']/g)];
  console.log('\n=== AUTH COMMANDS ===');
  for (const m of [...new Set(loginCmds.map(m => m[1]))].sort()) {
    console.log(' ', m);
  }
}

// ===================== 8. 提取文件上传/下载配置 =====================
function extractFileConfig() {
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js') && !isThirdParty(f));
  const mimeTypes = new Set();
  const extensions = new Set();
  
  for (const file of files) {
    const src = readChunk(file);
    const m1 = [...src.matchAll(/[`"']([a-z]+\/[a-z0-9._-]+)[`"']/g)];
    m1.forEach(m => mimeTypes.add(m[1]));
    
    const m2 = [...src.matchAll(/\.(md|py|js|ts|json|csv|txt|pdf|png|jpg|jpeg|gif|svg|zip|tar|gz)/g)];
    m2.forEach(m => extensions.add(m[1]));
  }
  
  console.log('\n=== MIME TYPES ===');
  for (const t of [...mimeTypes].sort().slice(0, 30)) console.log(' ', t);
  
  console.log('\n=== FILE EXTENSIONS ===');
  for (const e of [...extensions].sort()) console.log(' ', e);
}

// ===================== 执行 =====================
console.log('=== DEEP REVERSE ANALYSIS (Phase 3 - Business Logic) ===');
console.log('');

extractBusinessCommands();
extractSendMessageStructure();
extractModelConfig();
extractImageGenConfig();
extractHostConfig();
extractBillingConfig();
extractAuthFlow();
extractFileConfig();

console.log('\n=== DONE ===');
