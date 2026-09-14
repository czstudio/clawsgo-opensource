# THIRD-PARTY-NOTICES

本仓库的 `app/` 与 `site/` 是**生产构建产物**，其中包含大量第三方开源库的编译结果。
下表列出已识别的依赖及其许可。

> **免责说明**：下表依据产物特征与各库公开信息整理，**最终以各项目官方发布的 LICENSE 文本为准**。
> 产物是 minified 的，原始版权头已被构建工具剥离，因此无法从本仓库内逐字复现许可全文。
> 若你要再分发这些产物，请自行核对上游许可。

---

## 1. 运行时框架

| 包 | 许可 | 用途 | 可再分发 |
|---|---|---|---|
| `react` / `react-dom` (19) | MIT | UI 框架 | ✅ |
| `@tanstack/react-router` | MIT | 路由 | ✅ |
| `@tanstack/react-query` | MIT | 数据层 / 无限分页 | ✅ |
| `zustand` | MIT | 全局状态 | ✅ |
| `@base-ui-components/react` | MIT | UI 基座（弹层/定位/方向） | ✅ |
| `motion`（Framer Motion） | MIT | 动画 | ✅ |
| `tailwindcss` v4 + `tailwindcss-animate` | MIT | 样式与出入场动画 | ✅ |
| `@inlang/paraglide-js` | MIT | i18n | ✅ |

## 2. 编辑器与渲染

| 包 | 许可 | 用途 | 可再分发 | 备注 |
|---|---|---|---|---|
| `monaco-editor` | MIT | 代码 / LaTeX 编辑器（含 5 个 worker） | ✅ | |
| `shiki` | MIT | 只读语法高亮（含大量单语言 chunk） | ✅ | |
| `katex` | MIT | LaTeX 公式渲染 | ✅ | |
| `mermaid` | MIT | 图表 DSL | ✅ | |
| `pdfjs-dist` | **Apache-2.0** | PDF 渲染 | ✅ | ⚠️ 需保留其 NOTICE |
| `html-to-docx` | MIT | Word 导出 | ✅ | |
| `jszip` | MIT / GPL-3.0 **双许可** | 目录打包下载 | ✅ | ⚠️ 使用时须落在 MIT 分支 |
| `xterm` / `@xterm/xterm` | MIT | 终端 | ✅ | |
| `recharts` | MIT | 图表 | ✅ | |
| `echarts` | **Apache-2.0** | 图表（与 recharts 并存） | ✅ | ⚠️ 需保留其 NOTICE |
| `three` | MIT | WebGL / 3D 预览 | ✅ | |
| `SvgEditor`（SVG-Edit 血统） | MIT / Apache-2.0 | 矢量编辑 | ⚠️ | ⚠️ 需确认派生来源与署名要求 |

## 3. 外部服务（非库，通过运行时加载）

| 服务 | 用途 | 位置 |
|---|---|---|
| DiceBear (`www.dicebear.com`) | 头像生成 | 运行时请求 |
| 阿里云验证码 (`o.alicdn.com`) | 登录防刷 | 运行时脚本；离线环境静默失败 |
| ONLYOFFICE / 腾讯文档 SDK | Office 在线编辑 | `/web-apps/apps/api/documents/api.js`，本地由 `server/lib/office-stub.mjs` 顶替 |

## 4. 不适用于本许可的资产

| 资产 | 位置 | 权属 |
|---|---|---|
| 站点代码产物与营销文案 | `app/`、`site/*.html` | 原开发者 / 公司 |
| 产品名与 Logo | 全站 | 商标权归其所有者 |
| **10 所高校校徽** | `site/logos/` | MIT / Stanford / Tsinghua / Harvard / Princeton / ETH Zurich / U Tokyo / Caltech / Berkeley / Yale —— **校徽为注册商标，有独立权属** |
| 招聘海报 | `site/join-us-poster.jpg` | 可能含真人肖像 |
| 第三方库 | 见上表 | 各自许可 |

> 详见 [NOTICE.md](./NOTICE.md) 与 [LICENSE](./LICENSE) 的「适用范围说明」。

---

## 5. 如果你要发布生产版本

建议做一次完整的许可审计，把上游 LICENSE 全文收进本文件：

```bash
# 1) 从产物中提取残留的版权头（多数已被剥离，命中有限）
grep -rhoE 'Copyright[^\n]{0,120}' app/assets site/_next | sort -u

# 2) 更可靠的做法：按 docs/04-功能与依赖清单.md 的列表，从上游仓库取 LICENSE
# 3) 用自动化工具扫一遍
npx license-checker --production --json > licenses.json
```
