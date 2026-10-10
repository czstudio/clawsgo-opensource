// SSE 中枢：/api/subscribeEvents 的帧广播与运行态快照。
// 帧格式与前端 useConversationStream 的解析器严格对应（见 docs/07-数据形状.md）。

const IDLE_PING_MS = 25_000;

export class SseHub {
  constructor() {
    /** @type {Set<{id:string,userId:string,teamId:string,res:import('node:http').ServerResponse,ping:NodeJS.Timeout}>} */
    this.clients = new Set();
    /** @type {Map<string, {conversationId:string,teamId:string,userId:string,messageId:string,parts:any[],permissions:any[],settled:null|{metadata:any}}>} */
    this.runs = new Map();
  }

  /** 建立一条 SSE 连接，立即下发 channel-ack 与运行中会话快照 */
  subscribe({ res, userId, teamId }) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const client = { id: Math.random().toString(36).slice(2), userId, teamId, res, ping: null };
    this.clients.add(client);

    const running = [...this.runs.values()]
      .filter((r) => r.teamId === teamId && !r.settled)
      .map((r) => ({ conversationId: r.conversationId, messageId: r.messageId }));

    this.write(client, { t: 'channel-ack', running });

    // 把仍在运行的会话当前 parts 推成 snapshot，便于刷新后恢复。
    // 前端 useConversationStream 读 turnRows/hostOffline/contextTokens（缺省容忍，但补齐字段保持同形）。
    for (const r of this.runs.values()) {
      if (r.teamId !== teamId) continue;
      this.write(client, {
        t: 'snapshot',
        conversationId: r.conversationId,
        teamId: r.teamId,
        messageId: r.messageId,
        turnRows: r.turnRows,
        parts: r.parts,
        permissions: r.permissions,
        hostOffline: r.hostOffline ?? false,
        contextTokens: r.contextTokens,
      });
    }

    client.ping = setInterval(() => this.write(client, { t: 'ping', at: Date.now() }), IDLE_PING_MS);
    if (client.ping.unref) client.ping.unref();

    const close = () => this.unsubscribe(client);
    res.on('close', close);
    res.on('error', close);
    return client;
  }

  unsubscribe(client) {
    if (client.ping) clearInterval(client.ping);
    this.clients.delete(client);
  }

  write(client, frame) {
    try {
      client.res.write(`data: ${JSON.stringify(frame)}\n\n`);
    } catch {
      this.unsubscribe(client);
    }
  }

  /** 向同团队所有连接广播 */
  publish(frame, { teamId } = {}) {
    for (const c of this.clients) {
      if (teamId && c.teamId !== teamId) continue;
      this.write(c, frame);
    }
  }

  // ---------- 运行态 ----------

  startRun({ conversationId, teamId, userId, messageId, parts = [], permissions = [] }) {
    const run = {
      conversationId,
      teamId,
      userId,
      messageId,
      parts,
      permissions,
      hostOffline: false,
      contextTokens: undefined,
      settled: null,
    };
    this.runs.set(conversationId, run);
    this.publish({ t: 'run-started', conversationId, teamId, messageId }, { teamId });
    return run;
  }

  run(conversationId) {
    return this.runs.get(conversationId) ?? null;
  }

  snapshot(run) {
    this.publish(
      {
        t: 'snapshot',
        conversationId: run.conversationId,
        teamId: run.teamId,
        messageId: run.messageId,
        turnRows: run.turnRows,
        parts: run.parts,
        permissions: run.permissions,
        hostOffline: run.hostOffline ?? false,
        contextTokens: run.contextTokens,
      },
      { teamId: run.teamId },
    );
  }

  /** 上下文用量（前端写进 run 态 contextTokens，用于「Context N%」指示） */
  runContext(run, tokens) {
    run.contextTokens = tokens;
    this.publish(
      { t: 'run-context', conversationId: run.conversationId, tokens },
      { teamId: run.teamId },
    );
  }

  /** 运行中主机离线/恢复（前端置 hostOffline → 任务显示 paused） */
  runHost(run, offline) {
    run.hostOffline = !!offline;
    this.publish(
      { t: 'run-host', conversationId: run.conversationId, offline: !!offline },
      { teamId: run.teamId },
    );
  }

  /** 主机列表/状态粗粒度变更（前端走 onCoarse 触发主机侧刷新） */
  hostPresence(teamId, extra = {}) {
    this.publish({ t: 'host-presence', teamId, ...extra }, { teamId });
  }

  /** 生图任务更新（前端 onCoarse 触发生图区刷新） */
  imageUpdated(teamId, frame = {}) {
    this.publish({ t: 'image-updated', teamId, ...frame }, { teamId });
  }

  /** 会话已读回执（前端 onCoarse 触发未读数刷新） */
  conversationRead(teamId, conversationId) {
    this.publish(
      { t: 'conversation-read', teamId, conversationId },
      { teamId },
    );
  }

  part(run, index, part) {
    this.publish({ t: 'part', conversationId: run.conversationId, index, part }, { teamId: run.teamId });
  }

  delta(run, index, delta) {
    this.publish(
      { t: 'part-delta', conversationId: run.conversationId, index, delta },
      { teamId: run.teamId },
    );
  }

  trackPart(run, index, at, part, agentId) {
    this.publish(
      {
        t: 'track-part',
        conversationId: run.conversationId,
        index,
        at,
        part,
        ...(agentId ? { agentId } : {}),
      },
      { teamId: run.teamId },
    );
  }

  permission(run, request) {
    this.publish(
      { t: 'permission', conversationId: run.conversationId, request },
      { teamId: run.teamId },
    );
  }

  permissionAnswered(run, requestId) {
    this.publish(
      { t: 'permission-answered', conversationId: run.conversationId, requestId },
      { teamId: run.teamId },
    );
  }

  titleUpdated(run, title) {
    this.publish(
      {
        t: 'title-updated',
        teamId: run.teamId,
        conversationId: run.conversationId,
        title,
      },
      { teamId: run.teamId },
    );
  }

  finish(run, metadata) {
    run.settled = { metadata };
    this.publish(
      { t: 'done', conversationId: run.conversationId, messageId: run.messageId, metadata },
      { teamId: run.teamId },
    );
    // 保留 30s 供断线重连拿到 snapshot，之后清理
    const t = setTimeout(() => {
      const cur = this.runs.get(run.conversationId);
      if (cur === run) this.runs.delete(run.conversationId);
    }, 30_000);
    if (t.unref) t.unref();
  }
}

export const hub = new SseHub();
