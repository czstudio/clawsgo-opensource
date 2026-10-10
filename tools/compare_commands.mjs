import fs from 'node:fs';

// 1. 从后端提取所有已注册命令
const indexSrc = fs.readFileSync('server/api/index.mjs', 'utf8');
const importMatches = [...indexSrc.matchAll(/import \{ commands as (\w+) \} from ['"']\.\/(.+)['"'];/g)];
const backendCmds = new Set();
for (const [_, varName, file] of importMatches) {
  const filePath = `server/api/${file}`;
  const src = fs.readFileSync(filePath, 'utf8');
  const exportMatch = src.match(/export const commands = \{([^}]+)\}/s);
  if (exportMatch) {
    const content = exportMatch[1];
    const cmds = [...content.matchAll(/(\w+):/g)];
    for (const m of cmds) backendCmds.add(m[1]);
  }
}

// 2. 从前端 chunks 提取命令
const ASSETS = '.live/app/assets';
const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js') && f.length < 60);
const frontendCmds = new Set();
const knownPrefixes = /^(get|set|create|update|delete|remove|send|stop|start|pause|resume|cancel|retry|answer|request|generate|convert|export|import|install|uninstall|enable|disable|open|close|read|write|copy|move|rename|validate|verify|check|test|debug|run|migrate|settle|recall|promote|demote|archive|unarchive|share|unshare|mark|quote|sync|probe|pick|redeem|claim|apply|void|issue|refund|grant|revoke|register|prepare|rebuild|clean|reorder|accept|reject|invite|join|leave|switch|toggle|attach|detach|upload|download|search|list|admin)/;

for (const file of files) {
  try {
    const src = fs.readFileSync(`${ASSETS}/${file}`, 'utf8');
    const matches = [...src.matchAll(/[\x60"']([a-z][a-zA-Z0-9_]{4,45})[\x60"']\s*[,)]/g)];
    for (const m of matches) {
      const c = m[1];
      if (knownPrefixes.test(c)) frontendCmds.add(c);
    }
  } catch {}
}

// 3. 过滤前端命令（排除第三方库函数）
const thirdPartyPatterns = [
  /^getAll/, /^getBlock/, /^getChar/, /^getColumn/, /^getCommit/, /^getCount/,
  /^getCurrent/, /^getCurve/, /^getDebug/, /^getDefault/, /^getDest/, /^getDiagram/,
  /^getDir$/, /^getDrawable/, /^getEdge/, /^getElement/, /^getExclud/, /^getExplicit/,
  /^getFlow/, /^getFor/, /^getGraph/, /^getGroup/, /^getHead/, /^getHeight$/, /^getHidden/,
  /^getID$/, /^getIds/, /^getIndent/, /^getIndex/, /^getInt16/, /^getInterior/,
  /^getItemName/, /^getKey/, /^getLabel/, /^getLogger/, /^getMax/, /^getNode/, /^getNote/,
  /^getNumber/, /^getOptimized/, /^getOrAdd/, /^getOwner/, /^getParen/, /^getParent/,
  /^getPaymentDoc/, /^getPrev/, /^getProd/, /^getProjectFile/, /^getRaw/, /^getReach/,
  /^getReference/, /^getRegExp/, /^getRel/, /^getRender/, /^getRequired/, /^getRoot/,
  /^getRow/, /^getRule/, /^getScale/, /^getScore/, /^getSegment/, /^getSelf/, /^getShape/,
  /^getSkill/, /^getSlot/, /^getStyle/, /^getTabb/, /^getTag/, /^getText/, /^getTheme/,
  /^getTick/, /^getTitle/, /^getToken/, /^getType/, /^getUnique/, /^getUrl/, /^getValue/,
  /^getVirtual/, /^getWeek/, /^getWidth/, /^getter$/,
  /^startFrame/, /^startOnLoad/, /^startPan/, /^startZoom/, /^start_left/, /^start_right/,
  /^startsWith$/, /^startx/, /^starty/,
  /^markKey/, /^marker/, /^marko$/, /^marks$/, /^markViews/,
  /^moveSegment/, /^moveText/, /^moveTo/, /^moveWord/, /^moved$/, /^moveit$/, /^moveout/,
  /^openBrace/, /^openBracket/, /^openOnHover/, /^openProp/, /^openRef/, /^openTag/,
  /^open_/,
  /^readAnchor/, /^readBlock/, /^readDoc/, /^readDouble/, /^readError/, /^readFile/,
  /^readIO/, /^readLn/, /^readOnly/, /^readParen/, /^readTag/,
  /^removeCycle/, /^removeDir/, /^removeScript/, /^removeScroll/, /^removeTemp/,
  /^renameInput/, /^renameInvite/, /^renameOnType/, /^renameProc/, /^renameSymbol/,
  /^reorderLayer/,
  /^runFunc/, /^runSwim/, /^runSync/, /^runThrows/,
  /^search_start/,
  /^sendProgress/, /^sendRequest/,
  /^syncOpts/, /^syncTex/, /^synclock/,
  /^testAmbig/, /^tester$/,
  /^writeBlock/, /^writeError/, /^writeFlow/, /^writeNode/, /^writeScalar/,
  /^copyArray/, /^copyAst/, /^copyDefault/, /^copyMove/, /^copyObject/, /^copySymbol/,
  /^cleanAndMerge/, /^cleanUpSvg/, /^cleanup/, /^cleanupComment/, /^cleanupText/,
  /^closeBrace/, /^closeBracket/, /^closeDelay/, /^closeHandler/, /^closeOnClick/,
  /^closeRef/, /^closeTag/, /^close_/, /^close_paren/, /^closed$/, /^closedBy/,
  /^acceptNode/, /^acceptRename/, /^acceptSnippet/, /^applyEdits/, /^applyGroup/,
  /^applyNode/, /^applyPadded/, /^applyStyle/, /^applyStyle/, /^applyInput/,
  /^checkBox/, /^checkSegment/, /^checkUnique/, /^checkWidth/, /^checkbox$/, /^checked$/,
  /^checker$/, /^checkm2$/, /^checkout$/,
  /^enableBack/, /^enablemenu/,
  /^prepareLang/, /^prepareLayout/,
  /^probeMcp/, /^probeSsh/,
  /^uploadTicket/, /^uploadHost/,
  /^applyCard/, /^claimCard/, /^claimInvite/,
];

const filteredFrontend = [...frontendCmds].filter(c => {
  if (c.length < 5 || c.length > 50) return false;
  for (const p of thirdPartyPatterns) {
    if (p.test(c)) return false;
  }
  return true;
});

// 4. 对比
const frontendSet = new Set(filteredFrontend);
const backendSet = backendCmds;

const onlyInFrontend = [...frontendSet].filter(c => !backendSet.has(c)).sort();
const onlyInBackend = [...backendSet].filter(c => !frontendSet.has(c)).sort();
const common = [...frontendSet].filter(c => backendSet.has(c)).sort();

console.log('=== COMMAND COVERAGE ANALYSIS ===\n');
console.log(`Frontend commands (filtered): ${frontendSet.size}`);
console.log(`Backend commands: ${backendSet.size}`);
console.log(`Common: ${common.length}`);
console.log(`Only in frontend (potential missing): ${onlyInFrontend.length}`);
console.log(`Only in backend (not used by frontend): ${onlyInBackend.length}\n`);

console.log('=== ONLY IN FRONTEND (may need backend implementation) ===');
for (const c of onlyInFrontend.slice(0, 50)) console.log(' ', c);
if (onlyInFrontend.length > 50) console.log(`  ... and ${onlyInFrontend.length - 50} more`);

console.log('\n=== ONLY IN BACKEND (may be internal/admin-only) ===');
for (const c of onlyInBackend.slice(0, 50)) console.log(' ', c);
if (onlyInBackend.length > 50) console.log(`  ... and ${onlyInBackend.length - 50} more`);

// Save report
const report = {
  frontendCount: frontendSet.size,
  backendCount: backendSet.size,
  commonCount: common.length,
  onlyInFrontend,
  onlyInBackend,
  common,
};
fs.writeFileSync('work/deep-reverse/command-coverage.json', JSON.stringify(report, null, 2));
console.log('\nReport saved to work/deep-reverse/command-coverage.json');
