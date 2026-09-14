/**
 * server/lib/office-stub.mjs —— 本地版 ONLYOFFICE DocsAPI 替身
 * ------------------------------------------------------------------
 * 前端加载编辑器的方式是（ChatTeamUsage-CqW9fk-p.js）：
 *
 *   let { serverUrl, config } = session;
 *   const api = await loadScript(`${serverUrl}/web-apps/apps/api/documents/api.js`);
 *   new api.DocEditor(elementId, { ...config, events });
 *
 * 线上 serverUrl 指向自建的 ONLYOFFICE DocumentServer。开源复刻里没有（也不该内置）
 * 一个完整的文档服务器，但**不能让预览面板直接报错崩掉** —— 所以这里提供一个
 * 行为兼容的最小替身：
 *   · 实现 window.DocsAPI.DocEditor 构造函数与 destroyEditor()
 *   · 按 config.document.url 把文件内容渲染成只读预览（文本 / 表格 / 图片 / PDF）
 *   · 触发 config 里的 onDocumentReady 等事件，让宿主组件的状态流正常走完
 *
 * 想接真实 ONLYOFFICE？把 CLAWSGO_ONLYOFFICE_URL 指向你的 DocumentServer，
 * 这个替身就不会被加载（前端会直接去取真实 api.js），其它代码一行都不用改。
 */

export const DOCS_API_PATH = '/web-apps/apps/api/documents/api.js';

/** 返回一段可直接作为 JS 响应体下发的脚本 */
export function docsApiScript() {
  return `/* ClawsGO 开源复刻 —— ONLYOFFICE DocsAPI 兼容替身（只读预览版） */
(function () {
  if (window.DocsAPI && window.DocsAPI.__clawsgoStub) return;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function paint(host, config, state) {
    var doc = (config && config.document) || {};
    var title = doc.title || 'document';
    var url = doc.url || '';
    var ext = String(doc.fileType || title.split('.').pop() || '').toLowerCase();
    var busy = state && state.busy;

    host.innerHTML =
      '<div class="cg-office">' +
        '<div class="cg-office-bar">' +
          '<span class="cg-office-name">' + esc(title) + '</span>' +
          '<span class="cg-office-tag">' + esc(config && config.documentType ? config.documentType : 'doc') + '</span>' +
          (busy ? '<span class="cg-office-hint">加载中…</span>' : '') +
        '</div>' +
        '<div class="cg-office-body"><div class="cg-office-loading">正在读取文档…</div></div>' +
      '</div>';

    var body = host.querySelector('.cg-office-body');

    if (!url) {
      body.innerHTML = '<div class="cg-office-empty">这个会话里没有可预览的文档地址。</div>';
      return;
    }

    fetch(url, { credentials: 'include' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var ct = r.headers.get('content-type') || '';
        if (/^image\\//.test(ct)) {
          return r.blob().then(function (b) {
            body.innerHTML = '<img class="cg-office-img" alt="' + esc(title) + '">';
            body.querySelector('img').src = URL.createObjectURL(b);
          });
        }
        if (/pdf/.test(ct) || ext === 'pdf') {
          return r.blob().then(function (b) {
            body.innerHTML = '<iframe class="cg-office-frame" title="' + esc(title) + '"></iframe>';
            body.querySelector('iframe').src = URL.createObjectURL(b);
          });
        }
        return r.text().then(function (t) {
          // 二进制但被当成文本读的情况（docx/xlsx/pptx），不硬渲染，给一句人话
          if (/^(docx|xlsx|pptx|doc|xls|ppt|odt|ods|odp)$/.test(ext)) {
            body.innerHTML =
              '<div class="cg-office-empty">' +
                '本地复刻未内置文档服务，无法在页面内编辑 ' + esc(ext) + '。' +
                '点右上角「下载」拿到原文件即可；' +
                '或把 CLAWSGO_ONLYOFFICE_URL 指向自建 DocumentServer 后重开此页。' +
              '</div>';
            return;
          }
          var lang = { py: 'python', js: 'javascript', ts: 'typescript', mjs: 'javascript', sh: 'bash', tex: 'latex' }[ext] || ext || 'text';
          body.innerHTML =
            '<div class="cg-office-meta">只读预览 · ' + esc(lang) + ' · ' + t.split('\\n').length + ' 行</div>' +
            '<pre class="cg-office-pre"><code>' + esc(t) + '</code></pre>';
        });
      })
      .catch(function (e) {
        body.innerHTML = '<div class="cg-office-empty">读取文档失败：' + esc(e.message || e) + '</div>';
      });
  }

  function DocEditor(elementId, config) {
    if (!(this instanceof DocEditor)) return new DocEditor(elementId, config);
    this.elementId = elementId;
    this.config = config || {};
    this.destroyed = false;

    var host = document.getElementById(elementId);
    if (!host) {
      // 宿主还没挂载：不抛异常，退化成一次异步重试（宿主组件是 useEffect 里挂的）
      var self = this;
      setTimeout(function () { if (!self.destroyed) DocEditor.call(self, elementId, config); }, 50);
      return this;
    }
    this.host = host;
    host.classList.add('cg-office-host');
    injectStyle();
    paint(host, this.config, { busy: true });
    paint(host, this.config, { busy: false });

    var ev = this.config.events || {};
    var payload = { data: { type: 'documentReady' }, documentType: this.config.documentType };
    try { ev.onDocumentReady && ev.onDocumentReady(payload); } catch (e) {}
    try { ev.onAppReady && ev.onAppReady(payload); } catch (e) {}
  }

  DocEditor.prototype.destroyEditor = function () {
    this.destroyed = true;
    if (this.host) this.host.innerHTML = '';
  };

  var styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    var css =
      '.cg-office-host{height:100%;}' +
      '.cg-office{display:flex;flex-direction:column;height:100%;background:var(--card,transparent);}' +
      '.cg-office-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid color-mix(in oklab,currentColor 12%,transparent);font-size:12px;}' +
      '.cg-office-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.cg-office-tag{margin-left:auto;border:1px solid color-mix(in oklab,currentColor 20%,transparent);border-radius:999px;padding:1px 8px;opacity:.7;text-transform:uppercase;font-size:10px;letter-spacing:.04em;}' +
      '.cg-office-hint{opacity:.6;}' +
      '.cg-office-body{flex:1;min-height:0;overflow:auto;}' +
      '.cg-office-loading,.cg-office-empty{padding:24px;font-size:13px;opacity:.7;line-height:1.7;}' +
      '.cg-office-meta{padding:8px 12px;font-size:12px;opacity:.6;}' +
      '.cg-office-pre{margin:0;padding:0 12px 16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;}' +
      '.cg-office-img{display:block;max-width:100%;height:auto;margin:0 auto;}' +
      '.cg-office-frame{width:100%;height:100%;border:0;}';
    var el = document.createElement('style');
    el.setAttribute('data-clawsgo', 'office-stub');
    el.textContent = css;
    document.head.appendChild(el);
  }

  window.DocsAPI = {
    __clawsgoStub: true,
    version: 'clawsgo-stub-1.0',
    DocEditor: DocEditor,
    DocEditorVersion: 'clawsgo-stub-1.0',
  };
})();
`;
}
