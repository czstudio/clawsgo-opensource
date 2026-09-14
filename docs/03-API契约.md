# 03 · API 契约（逆向还原）

> 全部内容从 `app.clawsgo.cn` 的生产 bundle 静态还原，**未经任何接口探测或认证绕过**。
> 机器可读版本：`contracts/commands.json`

## 1. 传输层

```js
// 还原自 app/assets/api-pyi_9PXn.js（已去混淆）
const API_BASE   = 'https://api.clawsgo.cn';   // 生产
const APP_DEV    = 'http://localhost:5173';    // 本地开发
const SITE_URL   = 'https://clawsgo.cn';
const TOKEN_KEY  = 'clawsgo_token';            // localStorage 键名
```

海外区（`.ai`）对应 `https://api.clawsgo.ai`。本地复刻时 `API_BASE` 已被改写为 `""`，于是请求落到同源 `/api/*`，由本地复刻后端接管。

### 端点形态

| 用途 | 方法 | 路径 |
|---|---|---|
| 业务命令 | `POST` | `/api/{command}` |
| 认证命令 | `POST` | `/api/auth/{command}` |
| 会话探测 | `GET` | `/api/auth/{command}` |

**全部用 POST。** 连查询类命令（`getHosts`）也是 POST——参数走 body，不用 query string。这是 RPC 风格而非 REST。

### 信封格式

```jsonc
// 请求
POST /api/getHosts
Authorization: Bearer <token>
Content-Type: application/json

{ "data": { "limit": 100, "offset": 0 } }

// 响应 · 成功
{
  "data": [ /* ... */ ]
}
// 响应头可选：set-auth-token: <新 token>   ← token 轮换

// 响应 · 失败
{
  "error": { "code": "UNAUTHORIZED", "message": "..." }
}
```

**每个请求都套一层 `data`**，每个成功响应也套一层 `data`。这是统一的信封，不是业务字段。

## 2. 客户端实现（还原后的可读版本）

```ts
class ApiError extends Error {
  code: string;
  banReason?: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ApiError';
  }
}

const getToken = () => localStorage.getItem('clawsgo_token');

function clearSession() {
  localStorage.removeItem('clawsgo_token');
  queryClient.clear();
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

/** token 轮换：服务端每次可下发新 token，客户端自动落盘 */
function rotateToken(res: Response) {
  const t = res.headers.get('set-auth-token');
  if (t) localStorage.setItem('clawsgo_token', t);
}

/** 401 统一处理：清 session 并跳登录，带 redirect 回跳 */
function handleError(e: unknown): never {
  if (e instanceof ApiError && e.code === 'UNAUTHORIZED' && getToken()) {
    clearSession();
    const { pathname, search } = window.location;
    window.location.href = `/login?redirect=${encodeURIComponent(pathname + search)}`;
  }
  throw e;
}

/* ---------- JSON 命令 ---------- */
async function api<T>(cmd: string, payload: unknown = {}): Promise<T> {
  try {
    const res = await fetch(`${API_BASE}/api/${cmd}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ data: payload }),
    });
    rotateToken(res);
    const json = await res.json();
    if (json.error) throw new ApiError(json.error.code, json.error.message);
    return json.data;
  } catch (e) {
    return handleError(e);
  }
}

/* ---------- 自动分页（每页 100） ---------- */
async function apiAll<T extends { id: string }>(
  cmd: string, payload: object, listKey: string,
): Promise<T[]> {
  const seen = new Map<string, T>();
  for (let offset = 0; ; offset += 100) {
    const page = await api<Record<string, T[]>>(cmd, { ...payload, limit: 100, offset });
    const rows = page[listKey];
    for (const row of rows) if (!seen.has(row.id)) seen.set(row.id, row);
    if (rows.length < 100) return [...seen.values()];
  }
}

/* ---------- 下载（Blob） ---------- */
async function apiBlob(cmd: string, payload: unknown = {}): Promise<Blob> {
  try {
    const res = await fetch(`${API_BASE}/api/${cmd}`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ data: payload }),
    });
    rotateToken(res);
    if (res.headers.get('content-disposition')) return await res.blob();
    if (res.headers.get('content-type')?.includes('application/json')) {
      const j = await res.json();
      throw new ApiError(j.error?.code ?? 'INTERNAL', j.error?.message ?? 'Unexpected JSON response');
    }
    throw new ApiError('INTERNAL', `${cmd} failed (${res.status})`);
  } catch (e) {
    return handleError(e);
  }
}

/* ---------- 原始 body（文件上传，非 JSON） ---------- */
async function apiRaw<T>(cmd: string, body: BodyInit): Promise<T> {
  const headers: Record<string, string> = {};
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${API_BASE}/api/${cmd}`, { method: 'POST', headers, body });
  rotateToken(res);
  const json = await res.json();
  if (json.error) throw new ApiError(json.error.code, json.error.message);
  return json.data;
}

/* ---------- 带进度的上传（XHR，因为 fetch 无法报上传进度） ---------- */
function apiUpload<T>(
  cmd: string, query: Record<string, string>, body: BodyInit,
  onProgress?: (ratio: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/${cmd}?${new URLSearchParams(query)}`);
    const t = getToken();
    if (t) xhr.setRequestHeader('Authorization', `Bearer ${t}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError('INTERNAL', `${cmd} failed (network error)`));
    xhr.onload = () => {
      const nt = xhr.getResponseHeader('set-auth-token');
      if (nt) localStorage.setItem('clawsgo_token', nt);
      try {
        const json = JSON.parse(xhr.responseText);
        if (json.error) throw new ApiError(json.error.code, json.error.message);
        resolve(json.data);
      } catch (e) {
        try { handleError(e); } catch (e2) { reject(e2); }
      }
    };
    xhr.send(body);
  });
}

/* ---------- 认证命名空间 ---------- */
async function authPost<T>(cmd: string, payload: unknown = {}, extraHeaders = {}) {
  const res = await fetch(`${API_BASE}/api/auth/${cmd}`, {
    method: 'POST',
    headers: { ...authHeaders(), ...extraHeaders },
    body: JSON.stringify(payload),
  });
  return unwrapAuth(res);
}

async function authGet<T>(cmd: string) {
  const res = await fetch(`${API_BASE}/api/auth/${cmd}`, { headers: authHeaders() });
  return unwrapAuth(res);
}

async function unwrapAuth(res: Response) {
  rotateToken(res);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fallback = res.status === 429 ? 'TOO_MANY_REQUESTS' : 'AUTH_ERROR';
    const err = new ApiError(json?.code ?? fallback, json?.message ?? 'Authentication failed');
    if (typeof json?.banReason === 'string') err.banReason = json.banReason;
    throw err;
  }
  return json;
}
```

### 值得注意的设计点

| 设计 | 说明 |
|---|---|
| **token 轮换** | 每个响应都可能带 `set-auth-token` 换发新 token，客户端无条件落盘。这是滑动过期 + 防重放的做法 |
| **`banReason` 独立字段** | 封禁不只是一个错误码，还带理由文案，登录页会单独渲染 |
| **429 特殊化** | 状态码 429 映射为 `TOO_MANY_REQUESTS`，其余非 2xx 归为 `AUTH_ERROR` |
| **上传走 XHR** | 为了上传进度条。`fetch` 只有下载进度 |
| **下载认 header** | 以 `content-disposition` 存在与否判断响应是文件还是错误 JSON |
| **自动分页去重** | `apiAll` 用 `Map<id>` 去重，防止后端在分页期间插入数据导致重复 |

## 3. 认证命令

```
phone-number/send-otp                 发送短信验证码
phone-number/verify                   验证码登录     { phoneNumber, code }
sign-in/phone-number                  密码登录       { phoneNumber, password }
phone-number/request-password-reset   请求重置密码
phone-number/reset-password           重置密码
one-time-token/generate               生成一次性 token（桌面端授权）
one-time-token/verify                 验证一次性 token   { token }
```

海外区替换为 `google` 系列（`authMethods: ['google']`），bundle 里以 `authMethods.includes('google')` 分支控制 Google 登录按钮的渲染。

## 4. 业务命令全表（204 个）

### chat · 对话与消息（30）

```
sendMessage                     发送一轮消息
stopMessage                     中断当前生成
getMessages                     拉取消息列表
updateConversation              改标题等
deleteConversation
archiveConversation / unarchiveConversation
shareConversation               生成分享链接
getArchivedItems                归档箱
searchAll                       全局搜索（对话/消息/文件）
createConversationEntry         新建产物条目（文件/图/表）
deleteConversationEntry
moveConversationEntry
renameConversationEntry
copyConversationEntry
copyAgentInstructions           复制本轮 agent 指令
openConversationEntryLocally    本地打开（桌面端）
openBrowserView                 打开云端浏览器视图
listFigures                     列出图表
compileLatex                    LaTeX 编译
getLatexCompletions             LaTeX 补全
syncTexForward / syncTexInverse SyncTeX 正反向定位
createConversationTerminal      新建终端会话
getConversationTerminals
attachConversationTerminal
closeConversationTerminal
createTerminalTicket            终端票据
createOfficeSession             Office 文档会话
```

> `syncTexForward` / `syncTexInverse` 是**源码 ↔ PDF 双向定位**，与营销页面「含 SyncTeX 与期刊引擎」的 LaTeX 工作台描述一致。

### files · 工作区文件（9）

```
getConversationFiles            文件列表
getConversationFileIndex        文件索引（供 agent 检索）
uploadConversationFile          → 用 apiUpload（带进度）
updateConversationFile
downloadConversationFile        → 用 apiBlob
downloadConversationDir         打包目录下载
createFileLink                  生成分享链接
createFileDirectTicket          直连票据（绕过网关）
getConversationGitStatus        工作区 git 状态
getConversationGitDiff          改动 diff
```

### agent-memory · 智能体记忆（6）

```
createAgentMemory / updateAgentMemory / deleteAgentMemory / listAgentMemory
readAgentFile / writeAgentFile
```

### projects · 项目（7）

```
createProject / getProject / updateProject / deleteProject
archiveProject / unarchiveProject / cloneProject
```

### hosts · 主机（19）

```
getHosts / createHost / updateHost / deleteHost / rebuildHost / cleanHostCache
getHostStatus / getHostEnvironment / getHostStorage / getHostDirectories
createHostDirectory / openHostView
getHostSkills / getHostSkillDetail / installHostSkill / uploadHostSkill
createSshServer / updateSshServer / deleteSshServer / getSshServers / probeSshServers
```

> 对应营销页「接入你的实验室 GPU：通过 SSH 注册实验室主机，agent 在你的硬件上跑重任务」。

### skills · 技能（10）

```
getSkills / getSkillDetail / getSkillFile
installSkill / uninstallSkill / setSkillEnabled
searchSkillMarket / listGithubSkills
```

### teams · 团队（16）

```
createTeam / getTeams / getTeamMembers / updateTeam / deleteTeam / setMemberLimit
createTeamInvitation / getTeamInvitations / cancelTeamInvitation
acceptTeamInvitation / rejectTeamInvitation
removeTeamMember / updateTeamMemberRole / transferTeamOwnership / leaveTeam
getMyInvitations
```

### billing · 计费（13）

```
getSubscription / getCreditLedger
getInvoices / createInvoice / deleteInvoice
getPaymentOrders / createPaymentOrder / syncPaymentOrder / recheckPaymentOrders
redeemCode
getMyInviteCodes / createInviteCode / renameInviteCode
```

`createPaymentOrder` 返回的 `payUrls`（微信支付链接）是前端唤起支付卡的依据；`/billing/return` 支付回跳后调 `syncPaymentOrder` 主动核对。

### support · 工单（7）

```
createTicket / getTickets / getTicket / replyTicket
uploadTicketAttachment / markTicketSeen / getTicketUnreadCount
getActiveAnnouncements
```

### usage · 用量（2）

```
getOverview / getUsageStats
```

### admin · 后台（64）

按域分组，命名规整（`adminGet*` 查询 / `admin*` 变更）：

```
用户    adminGetUsers? → getUsers, getUserDetail, banUser, unbanUser, setUserRole
        adminTopupCredits, adminGrantPlan, adminGetUserHosts
        adminGetUserInvites, adminGetUserLedger, adminGetUserOrders, adminGetUserTeams
主机    adminGetCloudHosts, adminGetHostSpec, adminUpdateHostSpec, adminRebuildHost
团队    adminGetTeams, adminGetTeamDetail, adminGetTeamMembers, adminGetTeamHosts
        adminGetTeamLedger, adminGetTeamOrders
支付    adminGetPaymentOrders, adminRefundPaymentOrder, adminSyncPaymentOrder
        adminSyncPaymentRefund
发票    adminGetInvoices, adminGetInvoiceStats, adminIssueInvoice, adminRejectInvoice
        adminRegisterRedInvoice                       ← 红票（中国税务）
增长    adminGetChannelReport, adminGetMigrationReport
邀请    adminGetInviteOverview, adminGetInviters, adminGetInviteCohorts
        adminGetInviteRiskReport, adminGetInviteCodeDetail
        adminGetInviteCodeInvitees, adminGetInviteCodeReport
        createInviteCode, renameInviteCode
推广    adminGetPromoters, adminGetPromoterDetail, adminSettlePromoter
兑换    adminGetRedeemCodes, adminCreateRedeemCodes, adminDisableRedeemCode
风控    adminGetExpiringSubscriptions
审计    adminGetAuditLogs
公告    adminGetAnnouncements, adminCreateAnnouncement
        adminUpdateAnnouncement, adminDeleteAnnouncement
工单    adminGetTickets, adminGetTicketStats, adminGetTicket, adminCloseTicket
        adminReplyTicket
对话    adminGetChatConversations, adminGetChatProjects, adminGetConversation
        adminGetConversationMessages, adminGetConversationFiles
        adminGetConversationCosts, adminDownloadConversationFile
        adminCreateFileLink, adminCreateOfficeSession
迁移    adminGetMigrationStatus, adminRunMigration, adminStopMigration
```

`adminRegisterRedInvoice`（红票登记）与 `adminRefundPaymentOrder` 的存在，进一步印证区域化设计——这套 admin 是中国区专用的（`invoicing: true`）。

## 5. 错误码

从代码路径可确认的：

| code | 触发 |
|---|---|
| `UNAUTHORIZED` | 401，且本地存在 token → 清 session + 跳登录 |
| `TOO_MANY_REQUESTS` | HTTP 429 |
| `AUTH_ERROR` | 其余认证失败 |
| `INTERNAL` | 响应非预期（不是文件也不是合法 JSON） |
| `BANNED` | 通过 `banReason` 字段传递，具体 code 未在客户端硬编码 |

## 6. 流式对话

`useConversationStream-C0Qxn0G5.js` 里出现 `text/event-stream`，配合入口的 `/api/subscribeEvents`，说明有两条流：

| 流 | 用途 |
|---|---|
| `/api/subscribeEvents` | 全局事件推送（任务状态、跨端同步） |
| `text/event-stream`（对话） | 对话 token 流 + tool 调用事件 |

**事件类型在 bundle 里没找到明文字面量**（服务端按 `data:` 帧下发 JSON，客户端按 `type` 字段分派），这部分需要真实后端才能确认。

## 7. 数据模型推断

从命令参数与本地种子数据可推的字段（**推测，非确证**）：

```ts
type User = {
  id: string; name: string; email: string | null; phoneNumber: string;
  avatarUrl: string | null; role: 'user' | 'admin' | string;
  plan: string; credits: number; locale: string; region: 'cn' | 'global';
  createdAt: string; isBanned: boolean;
};

type Host = {
  id: string; name: string; status: 'online' | 'offline';
  hostname: string; platform: string; arch: string;
  cpuCores: number; memoryGb: number;
  gpu: { name: string; memoryGb: number }[];
  storageUsedGb: number; storageTotalGb: number;
  lastSeenAt: string;
};
```

`limit` / `offset` 是通用分页参数；列表键名**因命令而异**（`items` / `users` / `tickets` / `teams` …），没有统一约定——这点在对接后端时要按命令逐个确认。
