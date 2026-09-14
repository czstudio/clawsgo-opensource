#!/usr/bin/env python3
"""Emit contracts/commands.json + contracts/routes.json from the recovered bundle."""
import os, re, json, collections

BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "clawsgo-opensource")
APP = os.path.join(BASE, "app", "assets")
OUT = os.path.join(BASE, "contracts")
os.makedirs(OUT, exist_ok=True)

DOM_EVENTS = {
    "click", "change", "blur", "focus", "load", "message", "connect", "disconnect",
    "canvas", "clipboard", "contextmenu", "paste", "wheel", "resize", "keydown",
    "keyup", "mousedown", "mouseup", "mousemove", "mouseover", "mouseleave",
    "touchstart", "touchend", "touchmove", "touchcancel", "gesturestart",
    "gesturemove", "gestureend", "leavepictureinpicture", "credentialsrequired",
    "serververification", "copy", "cut", "drag", "drop", "scroll", "input",
    "submit", "error", "open", "close", "abort", "online", "offline",
}

# --- re-run the alias tracer to get raw command hits -------------------------
API_MOD = "api-pyi_9PXn.js"
api_src = open(os.path.join(APP, API_MOD), encoding="utf-8", errors="replace").read()
exp = {}
em = re.search(r"export\s*\{([^}]*)\}", api_src)
if em:
    for part in em.group(1).split(","):
        part = part.strip()
        mm = re.match(r"([\w$]+)\s+as\s+([\w$]+)", part)
        if mm:
            exp[mm.group(2)] = mm.group(1)
        elif part:
            exp[part] = part

WRAPPERS = {"Q", "_e", "ve", "ge", "ye"}
exported = {a for a, l in exp.items() if l in WRAPPERS}

imp_re = re.compile(r"import\s*\{([^}]*)\}\s*from\s*[\"']\./" + re.escape(API_MOD) + r"[\"']")
hits = collections.Counter()
for f in sorted(os.listdir(APP)):
    if not f.endswith(".js"):
        continue
    src = open(os.path.join(APP, f), encoding="utf-8", errors="replace").read()
    if API_MOD not in src:
        continue
    aliases = set()
    for imp in imp_re.findall(src):
        for part in imp.split(","):
            part = part.strip()
            mm = re.match(r"([\w$]+)\s+as\s+([\w$]+)", part)
            if mm and mm.group(1) in exported:
                aliases.add(mm.group(2))
            elif part in exported:
                aliases.add(part)
    for a in aliases:
        for mm in re.finditer(re.escape(a) + r"\s*\(\s*[`\"']([^`\"']{2,80})[`\"']", src):
            c = mm.group(1)
            if "/" in c or " " in c or c.startswith("${") or c.startswith("#"):
                continue
            if c in DOM_EVENTS or c.lower() in DOM_EVENTS:
                continue
            hits[c] += 1

cmds = sorted(k for k in hits if k not in DOM_EVENTS)

GROUPS = [
    ("auth · 认证", r"^(sign-in|sign-out|one-time-token|phone-number|google|wechat|oauth|getProfile|updateProfile|uploadAvatar)"),
    ("session · 会话与设备", r"^(getDevices|registerDevice|revokeDevice|getDevicePresence)"),
    ("chat · 对话与消息", r"^(sendMessage|stopMessage|getMessages|updateConversation|deleteConversation|archiveConversation|unarchiveConversation|shareConversation|searchAll|getArchivedItems|createConversationEntry|deleteConversationEntry|moveConversationEntry|renameConversationEntry|copyConversationEntry|copyAgentInstructions|openConversationEntryLocally|openBrowserView|listFigures|compileLatex|getLatexCompletions|syncTex|getConversationTerminals|attachConversationTerminal|closeConversationTerminal|createConversationTerminal|createTerminalTicket|createOfficeSession)"),
    ("files · 工作区文件", r"^(getConversationFiles|getConversationFileIndex|uploadConversationFile|updateConversationFile|downloadConversationFile|downloadConversationDir|createFileLink|createFileDirectTicket|getConversationGit)"),
    ("agent-memory · 智能体记忆", r"^(createAgentMemory|updateAgentMemory|deleteAgentMemory|listAgentMemory|readAgentFile|writeAgentFile)"),
    ("projects · 项目", r"^(createProject|getProject|updateProject|deleteProject|archiveProject|unarchiveProject|cloneProject)"),
    ("hosts · 云端/实验室主机", r"^(getHost|createHost|updateHost|deleteHost|rebuildHost|cleanHostCache|openHostView|createSshServer|updateSshServer|deleteSshServer|getSshServers|probeSshServers)"),
    ("skills · 技能市场", r"^(getSkill|installSkill|uninstallSkill|setSkillEnabled|searchSkillMarket|listGithubSkills|getHostSkill|uploadHostSkill|installHostSkill)"),
    ("teams · 团队", r"^(createTeam|getTeam|updateTeam|deleteTeam|setMemberLimit|removeTeamMember|updateTeamMemberRole|transferTeamOwnership|leaveTeam|acceptTeamInvitation|rejectTeamInvitation|cancelTeamInvitation|getMyInvitations)"),
    ("billing · 计费与额度", r"^(getSubscription|getCreditLedger|getInvoices|createInvoice|deleteInvoice|getPaymentOrders|createPaymentOrder|syncPaymentOrder|recheckPaymentOrders|redeemCode|getMyInviteCodes|createInviteCode|renameInviteCode)"),
    ("support · 工单与公告", r"^(createTicket|getTicket|getTickets|replyTicket|uploadTicketAttachment|markTicketSeen|getActiveAnnouncements)"),
    ("usage · 用量", r"^(getUsageStats|getOverview)"),
    ("admin · 后台", r"^admin"),
]

buckets = collections.OrderedDict((g, []) for g, _ in GROUPS)
buckets["other · 其他"] = []
for c in cmds:
    placed = False
    for g, pat in GROUPS:
        if re.search(pat, c):
            buckets[g].append(c)
            placed = True
            break
    if not placed:
        buckets["other · 其他"].append(c)

contract = {
    "source": "static analysis of app.clawsgo.cn JS bundles",
    "transport": {
        "api_base_production": "https://api.clawsgo.cn",
        "app_origin_production": "https://app.clawsgo.cn",
        "marketing_origin_production": "https://clawsgo.cn",
        "global_region": {
            "api_base": "https://api.clawsgo.ai",
            "app_origin": "https://app.clawsgo.ai",
            "marketing_origin": "https://clawsgo.ai",
        },
        "command_endpoint": "POST /api/{command}",
        "auth_endpoint": "POST /api/auth/{command}   (GET for session probe)",
        "request_envelope": {"data": "<payload>"},
        "response_ok": {"data": "<payload>"},
        "response_error": {"error": {"code": "<CODE>", "message": "<text>"}},
        "token": {
            "storage": "localStorage['clawsgo_token']",
            "header": "Authorization: Bearer <token>",
            "rotation": "response header `set-auth-token` replaces the stored token",
        },
        "unauthorized": "code UNAUTHORIZED -> clear token -> location = /login?redirect=<path+search>",
        "pagination": "payload {limit, offset}; list keys vary per command (items|users|tickets|...)",
        "upload": "POST /api/{command}?<query> with a raw body (not JSON) via XHR, progress reported",
        "download": "POST /api/{command}; response carries `content-disposition` and is returned as a Blob",
        "streaming": "text/event-stream consumed by useConversationStream (chat token stream)",
    },
    "auth_commands": [
        "phone-number/send-otp",
        "phone-number/verify",
        "sign-in/phone-number",
        "phone-number/request-password-reset",
        "phone-number/reset-password",
        "one-time-token/generate",
        "one-time-token/verify",
    ],
    "regions": {
        "cn": {"gateways": ["wechat"], "defaultGateway": "wechat", "authMethods": ["phone"], "invoicing": True},
        "global": {"gateways": ["stripe"], "defaultGateway": "stripe", "authMethods": ["google"], "invoicing": False},
        "selected_at_build": "cn",
        "env_var": "VITE_REGION (apps/app/.env)",
    },
    "command_count": len(cmds),
    "commands_by_group": buckets,
}

with open(os.path.join(OUT, "commands.json"), "w", encoding="utf-8") as f:
    json.dump(contract, f, ensure_ascii=False, indent=2)

print(f"commands: {len(cmds)}")
for g, v in buckets.items():
    print(f"  {g:34} {len(v):>3}")

# ---------------------------- routes ----------------------------
ROUTE_ROWS = [
    ("/login", "登录（OTP / 密码 两种 tab）", "phone"),
    ("/chat", "对话主界面（默认工作区）", "auth"),
    ("/chat/$conversationId", "具体对话", "auth"),
    ("/share/$conversationId", "公开分享的只读对话", "public"),
    ("/home", "概览/落地页", "auth"),
    ("/showcase", "作品展示", "auth"),
    ("/skills", "技能库", "auth"),
    ("/hosts", "主机（SSH/GPU）管理", "auth"),
    ("/teams", "团队", "auth"),
    ("/invites", "邀请码", "auth"),
    ("/redeem", "兑换码", "auth"),
    ("/invoices", "发票", "auth"),
    ("/tickets", "工单列表", "auth"),
    ("/tickets/$ticketId", "工单详情", "auth"),
    ("/billing/return", "支付回跳", "auth"),
    ("/desktop-auth", "桌面端授权（一次性 token）", "public"),
    ("/migration", "数据迁移", "admin"),
    ("/admin", "后台总览", "admin"),
    ("/admin/users", "用户管理", "admin"),
    ("/admin/hosts", "主机管理", "admin"),
    ("/admin/teams", "团队管理", "admin"),
    ("/admin/payments", "支付订单", "admin"),
    ("/admin/invoices", "发票管理", "admin"),
    ("/admin/growth", "增长报表", "admin"),
    ("/admin/invites", "邀请/渠道", "admin"),
    ("/admin/promoters", "推广员", "admin"),
    ("/admin/redeem", "兑换码", "admin"),
    ("/admin/risk", "风控", "admin"),
    ("/admin/audit", "审计日志", "admin"),
    ("/admin/announcements", "公告", "admin"),
    ("/admin/tickets", "工单后台", "admin"),
    ("/admin/tickets/$ticketId", "工单后台详情", "admin"),
    ("/admin/migration", "迁移后台", "admin"),
]
with open(os.path.join(OUT, "routes.json"), "w", encoding="utf-8") as f:
    json.dump([{"path": a, "desc": b, "access": c} for a, b, c in ROUTE_ROWS], f, ensure_ascii=False, indent=2)
print(f"routes: {len(ROUTE_ROWS)}")
