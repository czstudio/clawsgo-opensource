# ClawsGO API 调用点详解 —— 从生产 bundle 提取

> 以下所有代码片段均来自 `.live/app/assets/*.js` 生产 bundle
> 分析时间：2026-10-10

---

## 1. 消息发送系统 (`api-DCTmFum4.js`)

### sendMessage

```javascript
api.post('sendMessage', {
  conversationId,
  messageId,          // 用户消息 ID
  assistantMessageId, // 助手消息 ID（预生成）
  text,
  files?,             // 附件数组 [{type:'file',...}]
  compact?,           // 压缩模式
  resume?,            // 恢复模式
  modelId,
  subagentModelId?,   // 子智能体模型
  effort,             // 'low' | 'medium' | 'high'
  mode,               // 'solo' | 'master-slave' | 'cluster'
  context,            // 上下文长度配置
  ensure? {           // 任务确保配置
    title: extractTitle(text).slice(0, 50)
  }
})
→ { userMessage, assistantMessage }
```

### stopMessage

```javascript
api.post('stopMessage', { conversationId })
```

### 关键状态

- `clawsgo_team` — sessionStorage key
- 消息发送失败记录 `sendFailed: {code, message}`
- `NOT_FOUND` 错误触发 `refetchMessages` + settle

---

## 2. 图像生成系统 (`useImages-BFTiyJ5D.js`)

### generateImage (multipart/form-data)

```javascript
const form = new FormData();
form.append('teamId', teamId);
form.append('kind', kind);        // 'vector' | 'raster' | 'sunburst' | 'flare'
form.append('model', model);       // 'gpt-image-2' | 'clawsgo-*'
form.append('prompt', prompt);
form.append('aspectRatio', aspectRatio); // 'auto' | '1:1' | '16:9' | '9:16'
form.append('count', String(count));
for (const file of files) form.append('images', file, file.name);
for (const id of sourceImageIds) form.append('sourceImageId', id);

api.upload('generateImage', form, { team: teamId })
→ { images: [{ id, url, svg?, size, status, ... }] }
```

### 图片状态

- `pending` — 生成中，15 秒轮询
- `failed` — 失败
- 正常 — 可下载

### 矢量图 URL

```javascript
image.kind === 'vector'
  ? image.svg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(image.svg)}`
    : ''
  : image.url
```

---

## 3. 文件上传系统 (`useUploadLimit-kJMc65Oh.js`)

### 直传票据

```javascript
createFileDirectTicket({ conversationId, ... })
→ { direct: { port, ticket, ttlMs } }
```

### 直传请求

```javascript
fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'authorization': `Bearer ${ticket}`
  },
  body: JSON.stringify(data)
})
```

### 上传限制

- 默认：300KB
- 桌面端：30KB
- 超时：2 秒
- 最多 10 个文件同时上传

---

## 4. 团队系统 (`useCurrentTeam-6yygZegC.js`)

### 权限判断

```javascript
const isAdmin = role !== 'member';
const isSelf = member.id === member.userId;
```

### 完整命令

```javascript
getTeams() → { teams }
getTeamMembers({ teamId }) → members
getTeamInvitations({ teamId }) → { invitations }
getMyInvitations() → { invitations }
createTeam(data) → { team }
updateTeam(data) → { team }
deleteTeam(data)
leaveTeam(data)
createTeamInvitation(data)
cancelTeamInvitation(data)
acceptTeamInvitation(data)
rejectTeamInvitation(data)
removeTeamMember(data)
```

---

## 5. 工单系统 (`useTickets-uFech6pu.js` + `useAdminTickets-DHUuqSHT.js`)

### 用户端

```javascript
getMyTickets({ limit: 50, offset: 0 }) → tickets
getTicket({ id }) → ticket              // 10 秒轮询
uploadTicketAttachment(FormData) → { attachment }
createTicket(data) → { ticket }
replyTicket(data)
markTicketSeen(data)
getTicketUnreadCount() → { count }       // 5 分钟缓存
```

### 管理端

```javascript
adminGetTickets(params) → tickets
adminGetTicketStats({}) → stats          // 60 秒轮询
adminGetTicket({ id }) → ticket          // 10 秒轮询
adminReplyTicket(data)
adminRecallTicketMessage(data)
adminCloseTicket(data)
adminDeleteTicket(data)
```

### 工单状态计算

```javascript
function getTicketStatus(status, lastMessageRole, deleted) {
  if (deleted) return 'deleted';
  if (status === 'closed') return 'closed';
  if (lastMessageRole === 'user') return 'awaiting';
  return 'open';
}
```

---

## 6. 发票系统 (`useAdminInvoices-Ce7NOpZx.js`)

```javascript
adminGetInvoices(params) → invoices
adminGetInvoices({ teamId, limit: 1, offset: 0 }) → { invoicing }
adminGetInvoiceStats({}) → stats         // 60 秒轮询
adminIssueInvoice(data)
adminRejectInvoice(data)
adminRegisterRedInvoice(data)            // 红票登记
```

---

## 7. 主机系统 (`useConversations-BY-_h6tM.js`)

```javascript
getHosts({ teamId }) → hosts
createHost({ kind: 'cloud', teamId })
createHost({ kind: 'local', teamId, ... })
getDevices({}, { team: null }) → { devices }
updateHost(data)
deleteHost({ hostId })
getHostDirectories({ hostId, path, hidden }) → directories
```

**主机类型**：`cloud`（远程 SSH）| `local`（桌面直连）

---

## 8. 邀请系统 (`useAdminInvites-B1T7Q8hB.js`)

```javascript
adminGetInviteOverview({ timeZone, days })   // days: 7|30|90
adminGetInviteCohorts({ timeZone })
adminGetInviters(params)
adminGetInviteCodeReport(params)
adminGetInviteCodeDetail({ inviteCodeId, timeZone, days })
adminGetInviteCodeInvitees({ inviteCodeId, ...params })
```

---

## 9. 用户资料 (`useProfile-Y_QDaxbA.js`)

```javascript
getProfile() → { profile }
updateProfile(data) → { profile }
uploadAvatar(data) → { profile }
```

---

## 10. 计费系统 (`useBilling-BHtkaT9V.js`)

```javascript
getSubscription({ teamId }) → { subscription }
getCreditLedger({ teamId, limit: 50, offset }) → { entries }
```

**周期计算**：
```javascript
const nextCycle = new Date(Date.parse(subscription.cycleStartAt) + cycleDuration);
return subscription.planEndAt && nextCycle < Date.parse(subscription.planEndAt)
  ? nextCycle
  : null;
```

---

## 11. 文件系统 (`useConversationFiles-C-BNYCcu.js`)

```javascript
conversationFiles({ conversationId, path }) → files
fileIndex({ conversationId }) → fileIndex
```

**文件排序**：目录在前，按名称字母顺序（`Intl.Collator('en')`）

**Git 状态文件**：`.git/rebase-merge`, `.git/rebase-apply`, `.git/MERGE_HEAD`, `.git/CHERRY_PICK_HEAD`, `.git/REVERT_HEAD`

---

## 12. 调试端点（红队发现）

生产环境暴露以下**认证后可见**端点：

```
/api/commands, /api/debug/commands, /api/debug/routes
/api/docs, /api/openapi.json, /api/schema
/api/server/info, /api/system/info, /api/version
/api/config, /api/settings, /api/swagger.json
/api/v1/docs, /api/v2/docs, /api/internal/docs
```

**获取方式**：`Cookie: clawsgo-auth-token=<token>` 或 `Authorization: Bearer <token>`

---

*分析完成：2026-10-10*
*数据来源：1097 个生产 JS chunk 逐字节提取*