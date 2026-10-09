import{s as e}from"./useConversationFiles-C-BNYCcu.js";import{H as t,R as n,W as r,g as i,n as a,p as o,t as s,v as c}from"./previewWidgets-BbHpbU04.js";import{l}from"./useUploadLimit-kJMc65Oh.js";import{t as u}from"./preload-helper-Czpn1I53.js";import{dt as d}from"./dist-CUOG7dCS.js";import{a as f,c as p,o as m,s as ee}from"./browser-BIjqQRpZ.js";var h=`0a0a0a`,g=`737373`,_=`e5e5e5`,v=`f5f5f5`,y=`f7f7f7`,b={note:{fill:`eef5ff`,title:`155dfc`},tip:{fill:`ebfaf5`,title:`009966`},important:{fill:`f6f1ff`,title:`7f22fe`},warning:{fill:`fff5e6`,title:`e17100`},caution:{fill:`ffeeef`,title:`e7000b`}},x=Object.keys(b),te={comment:`6a737d`,keyword:`d73a49`,constant:`005cc5`,string:`032f62`,function:`6f42c1`,builtin:`e36209`,deleted:`b31d28`},S=JSON.stringify({"text-color":null,"background-color":null,"line-number-color":null,"line-number-background-color":null,"text-styles":Object.fromEntries(Object.entries({Keyword:`keyword`,ControlFlow:`keyword`,Import:`keyword`,Preprocessor:`keyword`,DataType:`function`,Function:`function`,DecVal:`constant`,BaseN:`constant`,Float:`constant`,Constant:`constant`,SpecialChar:`constant`,Attribute:`constant`,Char:`string`,String:`string`,VerbatimString:`string`,SpecialString:`string`,Comment:`comment`,Documentation:`comment`,Annotation:`comment`,CommentVar:`comment`,RegionMarker:`comment`,Information:`comment`,Warning:`comment`,BuiltIn:`builtin`,Alert:`deleted`,Error:`deleted`}).map(([e,t])=>[e,{"text-color":`#${te[t]}`}]))});function C(e){return Array.from(e.querySelectorAll(`pre`),e=>({pre:e,block:e.parentElement?.matches(`div.sourceCode`)?e.parentElement:e,language:Array.from(e.classList).find(e=>e!==`sourceCode`)??``}))}var w=`'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif`,T=`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace`,E=`:is(h1, h2, h3, h4, h5, h6)`,ne=`
  @page { margin: 14mm; }
  *, *::before, *::after { box-sizing: border-box; }
  html { font-size: 15px; }
  body {
    margin: 0;
    font-family: ${w};
    font-size: 15px;
    line-height: 1.75;
    color: #${h};
    overflow-wrap: break-word;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .md-export :where(p, ul, ol, dl, blockquote, pre, figure, .md-table, .md-callout, .md-math-block) { margin: 1rem 0; }
  .md-export div.sourceCode { margin: 1rem 0; }
  .md-export li > :where(ul, ol) { margin: 0; }
  .md-export > :first-child, .md-export :is(blockquote, .md-callout, td, th) > :first-child { margin-top: 0; }
  .md-export > :last-child, .md-export :is(blockquote, .md-callout, td, th) > :last-child { margin-bottom: 0; }

  .md-export ${E} {
    font-size: 1em;
    font-weight: 600;
    line-height: 1.35;
    letter-spacing: -0.01em;
    margin: calc(1em + 0.25rem) 0 0.25rem;
    padding-bottom: 0.25em;
    break-after: avoid;
  }
  .md-export ${E} + :not(${E}), .md-export ${E} + div.sourceCode { margin-top: 0; }
  .md-export h1 { font-size: 1.6em; }
  .md-export h2 { font-size: 1.3333em; }
  .md-export h3 { font-size: 1.1333em; }

  .md-export :where(strong, b) { font-weight: 600; }
  .md-export a {
    color: inherit;
    text-decoration-line: underline;
    text-decoration-color: #${g};
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }
  .md-export code {
    font-family: ${T};
    font-size: 0.9333em;
    font-variant-numeric: tabular-nums;
    background: #${v};
    padding: 0.125em 0.3em;
    border-radius: 6px;
  }

  .md-export :where(ul, ol) { padding-left: 1.5em; }
  .md-export li::marker { color: #${g}; font-variant-numeric: tabular-nums; }
  .md-export ul.task-list { list-style: none; }
  .md-export ul.task-list input[type='checkbox'] {
    width: 0.9em;
    height: 0.9em;
    margin: 0 0.5em 0 -1.4em;
    vertical-align: -0.1em;
    accent-color: #${h};
  }

  .md-export pre {
    font-family: ${T};
    font-size: 0.9333em;
    line-height: 1.65;
    font-variant-numeric: tabular-nums;
    white-space: pre-wrap;
    background: #${v};
    border-radius: 14px;
    padding: 0.5em 1em 2.15em;
  }
  .md-export pre::before {
    content: attr(data-lang) '\\200b';
    display: block;
    font-family: ${w};
    font-size: 12px;
    line-height: 28px;
    color: #${g};
  }
  .md-export pre code { font-size: 1em; background: none; padding: 0; border-radius: 0; }
  .md-export pre > code.sourceCode { white-space: pre-wrap; }
  .md-export pre > code.sourceCode > span { line-height: inherit; text-indent: 0; padding-left: 0; }

  .md-export blockquote { padding-left: calc(1em - 2px); border-left: 2px solid #${_}; }
  .md-export .md-callout { padding: 0.5em 0.875em; border-radius: 14px; }
  .md-export .md-callout > .title > p { display: flex; align-items: center; gap: 0.375em; margin: 0; font-weight: 600; }
  .md-export .md-callout > .title + * { margin-top: 0; }
  .md-export .md-callout > .title svg { width: 18px; height: 18px; flex: none; }
  ${x.map(e=>`.md-export .md-callout.${e} { background: #${b[e].fill}; } .md-export .md-callout.${e} > .title { color: #${b[e].title}; }`).join(`
  `)}

  .md-export .md-math-block { padding: 0.5em 0; text-align: center; }
  .md-export .katex-display { margin: 0; overflow-x: auto; overflow-y: hidden; }
  .md-export .md-math-error { font-family: ${T}; font-size: 0.9333em; color: #${g}; white-space: pre-wrap; }

  .md-export .md-table { border: 1px solid #${_}; border-radius: 14px; overflow: hidden; }
  .md-export table { width: 100%; border-collapse: collapse; font-size: 0.9333em; line-height: 1.43; font-variant-numeric: tabular-nums; }
  .md-export :is(th, td) { padding: 0.5714em 1.1429em; border-bottom: 1px solid #${_}; vertical-align: top; text-align: left; }
  .md-export tr:last-child > td { border-bottom: 0; }
  .md-export th { background: #${y}; font-weight: 600; }
  .md-export table.md-wide :is(td, th) { overflow-wrap: anywhere; }

  .md-export img { max-width: 100%; height: auto; border-radius: 10px; }
  .md-export hr { height: 0; border: 0; border-top: 1px solid #${_}; margin: calc(1rem + 0.875rem) 0; }
  .md-export .footnotes { font-size: 0.9em; color: #${g}; }
`;function re(e){for(let{pre:t,language:n}of C(e.body))n&&(t.dataset.lang=n);for(let t of e.querySelectorAll(`table`)){if(t.parentElement?.closest(`table`))continue;let n=e.createElement(`div`);n.className=`md-table`,t.replaceWith(n),n.append(t)}for(let t of x)for(let n of e.querySelectorAll(`.md-callout.${t} > .title > p`))n.prepend(o(s[t].icon,``))}var D=11,O={h1:1.6,h2:1.3333,h3:1.1333,small:.9333,label:.8,footnote:.9},k=e=>Math.round(D*e*2),A=e=>Math.round(e*20),j=A(D),ie=A(D*.25),M=A(D*1.5),ae=A(D*.5),N=[`•`,`◦`,`▪`],P={width:11906,height:16838,margin:794},oe=P.width-2*P.margin,F=`http://schemas.openxmlformats.org/wordprocessingml/2006/main`,I=`<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei" w:cs="Arial"/>`,L=`<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei" w:cs="Consolas"/>`,R={tableText:`Table Text`,codeBar:`Source Code Bar`,rule:`Horizontal Rule`,calloutText:`Callout Text`,callout:e=>`Callout ${e[0].toUpperCase()}${e.slice(1)}`,calloutTitle:e=>`${R.callout(e)} Title`},z=e=>e.replace(/ /g,``),se=new Map(x.map(e=>[z(R.calloutTitle(e)),z(R.callout(e))])),ce=new Set([`p`,`div`,`section`,`ul`,`ol`,`dl`,`pre`,`table`,`blockquote`,`figure`,`hr`,`h1`,`h2`,`h3`,`h4`,`h5`,`h6`]);function le(e){let t=e.ownerDocument,n=(e,...n)=>{let r=t.createElement(`div`);return r.dataset.customStyle=e,r.append(...n),r},r=e=>{let n=t.createElement(`p`);return n.textContent=e,n};for(let r of e.querySelectorAll(`td, th`)){let e=[],i=null;for(let n of Array.from(r.childNodes))n instanceof Element&&ce.has(n.localName)?(i=null,e.push(n)):(i||n.textContent?.trim()||n instanceof Element)&&(i||e.push(i=t.createElement(`p`)),i.append(n));r.replaceChildren(n(R.tableText,...e))}for(let{block:t,language:i}of C(e))t.before(n(R.codeBar,r(i||`\xA0`)));for(let t of e.querySelectorAll(`hr`))t.closest(`.footnotes`)||t.replaceWith(n(R.rule,r(`\xA0`)));for(let r of Array.from(e.querySelectorAll(`div.md-callout`)).reverse()){let e=x.find(e=>r.classList.contains(e));if(!e)continue;r.querySelector(`:scope > .title`)?.setAttribute(`data-custom-style`,R.calloutTitle(e));let i=t.createElement(`table`);i.insertRow().insertCell().append(n(R.calloutText,...Array.from(r.childNodes))),r.replaceWith(i)}}var B=e=>`<w:sz w:val="${k(e)}"/><w:szCs w:val="${k(e)}"/>`,V=(e,t,n,r=1)=>`<w:spacing w:before="${e}" w:after="${t}" w:line="${A(D*r*n)}" w:lineRule="atLeast"/>`,H={vertical:5,horizontal:10},ue=(e,t=H.vertical)=>`<w:pBdr>${[`top`,`left`,`bottom`,`right`].map(n=>`<w:${n} w:val="single" w:sz="4" w:space="${n===`top`?H.vertical:n===`bottom`?t:H.horizontal}" w:color="${e}"/>`).join(``)}</w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="${e}"/>`,de=`<w:ind w:left="${A(H.horizontal+.5)}" w:right="${A(H.horizontal+.5)}"/>`,fe=Math.round(D*O.small*2.15);function U(e,t,n,r,{basedOn:i,next:a,custom:o=!0,isDefault:s=!1}={}){return`<w:style w:type="${e}"${s?` w:default="1"`:``}${o?` w:customStyle="1"`:``} w:styleId="${t}"><w:name w:val="${n}"/>${i?`<w:basedOn w:val="${i}"/>`:``}${a?`<w:next w:val="${a}"/>`:``}<w:qFormat/>${r}</w:style>`}var W=(e,t,n=``,r={})=>U(`paragraph`,z(e),e,`<w:pPr>${t}</w:pPr>${n&&`<w:rPr>${n}</w:rPr>`}`,{basedOn:`Normal`,...r});function pe(){let e=[O.h1,O.h2,O.h3,1,1,1].map((e,t)=>U(`paragraph`,`Heading${t+1}`,`heading ${t+1}`,`<w:pPr><w:keepNext/><w:keepLines/>${V(A(D*e)+ie,A(D*e*.25)+ie,1.35,e)}<w:outlineLvl w:val="${t}"/></w:pPr><w:rPr><w:b/><w:bCs/>${B(e)}</w:rPr>`,{basedOn:`Normal`,next:`BodyText`,custom:!1})),t=`<w:tblCellMar><w:top w:w="${A(D*.5)}" w:type="dxa"/><w:left w:w="${A(D*.875)}" w:type="dxa"/><w:bottom w:w="${A(D*.5)}" w:type="dxa"/><w:right w:w="${A(D*.875)}" w:type="dxa"/></w:tblCellMar>`,n=[`top`,`left`,`bottom`,`right`,`insideH`,`insideV`].map(e=>`<w:${e} w:val="nil"/>`).join(``),r=x.flatMap(e=>[U(`table`,z(R.callout(e)),R.callout(e),`<w:tblPr><w:tblBorders>${n}</w:tblBorders>${t}</w:tblPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${b[e].fill}"/></w:tcPr>`,{basedOn:`TableNormal`}),W(R.calloutTitle(e),`<w:keepNext/>${V(0,0,1.75)}`,`<w:b/><w:bCs/><w:color w:val="${b[e].title}"/>`,{basedOn:z(R.calloutText)})]),i=`${V(0,j,1.43,O.small)}<w:jc w:val="center"/>`,a=[`top`,`left`,`bottom`,`right`,`insideH`].map(e=>`<w:${e} w:val="single" w:sz="4" w:space="0" w:color="${_}"/>`).join(``);return`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${F}">
<w:docDefaults><w:rPrDefault><w:rPr>${I}<w:color w:val="${h}"/>${B(1)}<w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>${V(0,0,1.75)}</w:pPr></w:pPrDefault></w:docDefaults>
${U(`paragraph`,`Normal`,`Normal`,`<w:pPr>${V(0,j,1.75)}</w:pPr>`,{custom:!1,isDefault:!0})}
${W(`Body Text`,V(j,j,1.75),``,{custom:!1})}
${W(`First Paragraph`,V(0,j,1.75),``,{basedOn:`BodyText`,next:`BodyText`})}
${W(`Compact`,`${V(0,j,1.75)}<w:contextualSpacing/>`,``,{basedOn:`BodyText`})}
${e.join(`
`)}
${W(`Block Text`,`<w:pBdr><w:left w:val="single" w:sz="12" w:space="9" w:color="${_}"/></w:pBdr>${V(0,j,1.75)}<w:ind w:left="${j}"/>`,``,{basedOn:`BodyText`,custom:!1})}
${W(`Source Code`,`${ue(v,fe)}${V(0,j,1.65,O.small)}${de}`,`${L}${B(O.small)}`)}
${W(R.codeBar,`<w:keepNext/>${V(0,0,28/15)}`,`${I}<w:color w:val="${g}"/>${B(O.label)}`,{basedOn:`SourceCode`})}
${W(R.tableText,V(0,0,1.43,O.small),B(O.small))}
${W(R.rule,`<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="0" w:color="${_}"/></w:pBdr><w:spacing w:before="${j+A(D*.875)}" w:after="${j+A(D*.875)}" w:line="20" w:lineRule="exact"/>`,`<w:sz w:val="2"/><w:szCs w:val="2"/>`)}
${W(R.calloutText,V(0,j,1.75))}
${r.join(`
`)}
${W(`Definition Term`,`<w:keepNext/>${V(0,0,1.75)}`,`<w:b/><w:bCs/>`)}
${W(`Definition`,`${V(0,j,1.75)}<w:ind w:left="${M}"/>`)}
${U(`paragraph`,`FootnoteText`,`footnote text`,`<w:pPr>${V(0,0,1.5,O.footnote)}</w:pPr><w:rPr><w:color w:val="${g}"/>${B(O.footnote)}</w:rPr>`,{basedOn:`Normal`,custom:!1})}
${W(`Footnote Block Text`,`<w:ind w:left="${j}"/>`,``,{basedOn:`FootnoteText`})}
${U(`paragraph`,`Caption`,`caption`,`<w:pPr>${i}</w:pPr><w:rPr><w:color w:val="${g}"/>${B(O.small)}</w:rPr>`,{basedOn:`Normal`,custom:!1})}
${W(`Image Caption`,i,``,{basedOn:`Caption`})}
${W(`Table Caption`,i,``,{basedOn:`Caption`})}
${W(`Figure`,V(0,j,1.75))}
${W(`Captioned Figure`,`<w:keepNext/>${V(0,0,1.75)}`,``,{basedOn:`Figure`})}
${U(`character`,`DefaultParagraphFont`,`Default Paragraph Font`,``,{custom:!1,isDefault:!0})}
${U(`character`,`VerbatimChar`,`Verbatim Char`,`<w:rPr>${L}${B(O.small)}<w:shd w:val="clear" w:color="auto" w:fill="${v}"/></w:rPr>`,{basedOn:`DefaultParagraphFont`})}
${U(`character`,`Hyperlink`,`Hyperlink`,`<w:rPr><w:color w:val="${h}"/><w:u w:val="single" w:color="${g}"/></w:rPr>`,{basedOn:`DefaultParagraphFont`,custom:!1})}
${U(`character`,`FootnoteReference`,`footnote reference`,`<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>`,{basedOn:`DefaultParagraphFont`,custom:!1})}
${U(`table`,`TableNormal`,`Normal Table`,`<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>`,{custom:!1,isDefault:!0})}
${U(`table`,`Table`,`Table`,`<w:tblPr><w:tblBorders>${a}<w:insideV w:val="nil"/></w:tblBorders><w:tblCellMar><w:top w:w="${A(6)}" w:type="dxa"/><w:left w:w="${A(12)}" w:type="dxa"/><w:bottom w:w="${A(6)}" w:type="dxa"/><w:right w:w="${A(12)}" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:bCs/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${y}"/></w:tcPr></w:tblStylePr>`,{basedOn:`TableNormal`})}
</w:styles>`}var me=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${F}"><w:body><w:p/><w:sectPr><w:pgSz w:w="${P.width}" w:h="${P.height}"/><w:pgMar w:top="${P.margin}" w:right="${P.margin}" w:bottom="${P.margin}" w:left="${P.margin}" w:header="425" w:footer="425" w:gutter="0"/></w:sectPr></w:body></w:document>`;function he(){return new Blob([p({"word/document.xml":m(me),"word/styles.xml":m(pe())})])}var G=`pStyle.keepNext.keepLines.pageBreakBefore.framePr.widowControl.numPr.suppressLineNumbers.pBdr.shd.tabs.suppressAutoHyphens.kinsoku.wordWrap.overflowPunct.topLinePunct.autoSpaceDE.autoSpaceDN.bidi.adjustRightInd.snapToGrid.spacing.ind.contextualSpacing.mirrorIndents.suppressOverlap.jc.textDirection.textAlignment.textboxTightWrap.outlineLvl.divId.cnfStyle.rPr.sectPr.pPrChange`.split(`.`);function K(e,t,n){let r=e.ownerDocument,i=(e,t)=>Array.from(e.children).find(e=>e.localName===t),a=i(e,`pPr`)??e.insertBefore(r.createElementNS(F,`w:pPr`),e.firstChild),o=G.indexOf(t),s=i(a,t)??a.insertBefore(r.createElementNS(F,`w:${t}`),Array.from(a.children).find(e=>G.indexOf(e.localName)>o)??null);for(let[e,t]of Object.entries(n))s.setAttributeNS(F,`w:${e}`,t)}var q=(e,t)=>K(e,`spacing`,t),ge=/^(Heading\d|BodyText|HorizontalRule)$/;async function _e(e){let t=ee(new Uint8Array(await e.arrayBuffer())),n=(e,n)=>{if(!t[e])return;let r=new DOMParser().parseFromString(f(t[e]),`application/xml`);n(r);let i=new XMLSerializer().serializeToString(r);t[e]=m(i.startsWith(`<?xml`)?i:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${i}`)},r=(e,t)=>e?Array.from(e.children).find(e=>e.namespaceURI===F&&e.localName===t):void 0,i=(e,t)=>{for(let[n,r]of Object.entries(t))e.setAttributeNS(F,`w:${n}`,r);return e},a=new Set;n(`word/numbering.xml`,e=>{let t=(t,n={})=>i(e.createElementNS(F,`w:${t}`),n),n=new Set(Array.from(e.getElementsByTagNameNS(F,`abstractNum`)).filter(e=>/[☐☒]/.test(e.getElementsByTagNameNS(F,`lvlText`)[0]?.getAttributeNS(F,`val`)??``)).map(e=>e.getAttributeNS(F,`abstractNumId`)));for(let t of Array.from(e.getElementsByTagNameNS(F,`num`)))n.has(r(t,`abstractNumId`)?.getAttributeNS(F,`val`)??null)&&a.add(t.getAttributeNS(F,`numId`)??``);for(let n of Array.from(e.getElementsByTagNameNS(F,`lvl`))){let e=Number(n.getAttributeNS(F,`ilvl`))+1,a=r(n,`lvlJc`);a&&i(a,{val:`right`});let o=r(n,`pPr`)??n.appendChild(t(`pPr`));r(o,`ind`)?.remove(),o.append(t(`ind`,{left:String(M*e),hanging:String(ae)}));let s=r(n,`lvlText`),c=s?.getAttributeNS(F,`val`)??``;!c.trim()||/[☐☒]/.test(c)||(s&&r(n,`numFmt`)?.getAttributeNS(F,`val`)===`bullet`&&i(s,{val:N[(e-1)%N.length]}),r(n,`rPr`)?.remove(),n.appendChild(t(`rPr`)).append(t(`rFonts`,{ascii:`Arial`,hAnsi:`Arial`,hint:`default`}),t(`color`,{val:g})))}}),n(`word/document.xml`,e=>{let t=new Set,n=null;for(let i of Array.from(e.getElementsByTagNameNS(F,`p`))){let e=r(r(i,`pPr`),`numPr`),o=r(e,`numId`)?.getAttributeNS(F,`val`),s=r(e,`ilvl`)?.getAttributeNS(F,`val`)??`0`;if(!o){n=null;continue}let c=a.has(o),l=n&&s===`0`&&i.previousElementSibling?.localName===`p`,u=c?n?.level===`0`&&!n.task:!t.has(o);l&&u&&(q(i,{before:String(j)}),K(i,`contextualSpacing`,{val:`0`})),t.add(o),n={task:c,level:s}}for(let t of Array.from(e.getElementsByTagNameNS(F,`tbl`))){let e=r(t,`tblPr`),n=r(e,`tblW`);n?.getAttributeNS(F,`type`)===`auto`&&i(n,{type:`pct`,w:`5000`});let a=r(r(t,`tr`),`tc`),o=r(r(r(a,`p`),`pPr`),`pStyle`)?.getAttributeNS(F,`val`),s=o&&se.get(o),c=r(e,`tblStyle`);if(s&&a&&c){i(c,{val:s});let e=Array.from(a.children).filter(e=>e.localName===`p`).pop();e&&q(e,{after:`0`})}let l=t.nextElementSibling;if(l?.localName===`p`){let e=r(r(l,`pPr`),`pStyle`)?.getAttributeNS(F,`val`)??``;!Array.from(l.children).some(e=>e.localName!==`pPr`)&&l.nextElementSibling?.localName===`tbl`?q(l,{before:`0`,after:`0`,line:String(j),lineRule:`exact`}):ge.test(e)||q(l,{before:String(j)})}if(t.parentElement?.localName!==`body`)continue;let u=Array.from(r(t,`tblGrid`)?.children??[]),d=u.reduce((e,t)=>e+Number(t.getAttributeNS(F,`w`)),0);if(d>0)for(let e of u)i(e,{w:String(Math.round(Number(e.getAttributeNS(F,`w`))*oe/d))})}}),n(`word/settings.xml`,e=>{let t=e.documentElement;if(r(t,`compat`))return;let n=e.createElementNS(F,`w:compat`);n.append(i(e.createElementNS(F,`w:compatSetting`),{name:`compatibilityMode`,uri:`http://schemas.microsoft.com/office/word`,val:`15`})),t.insertBefore(n,r(t,`docVars`)??r(t,`rsids`)??r(t,`mathPr`)??r(t,`themeFontLang`)??null)});let o={};for(let[e,n]of Object.entries(t))o[e]=e.startsWith(`word/media/`)?[n,{level:0}]:n;return new Blob([p(o)])}function ve(e){return new Worker(`/assets/pandocWorker-DJsFZxzF.js`,{type:`module`,name:e?.name})}async function J(e){let t=new ve;Y.add(t);let n=null;t.onmessage=({data:e})=>n?.(e),t.onerror=e=>n?.({ok:!1,message:e.message||`Pandoc worker failed to load`});let r=e=>new Promise((r,i)=>{n=e=>{n=null,e.ok?r(e):i(Error(e.message))},t.postMessage(e)});try{return await e(r)}finally{t.terminate(),Y.delete(t)}}var Y=new Set;function ye(e){let r=e.replace(/\r\n?/g,`
`),i=d.of(r.split(`
`)),o=[],s=[],c=e=>{let t=i.lineAt(e.from);s.push({from:t.from,to:t.from,text:`${r.slice(t.from,e.from).trimEnd()}\n`})},l=(e,t)=>{for(;e?.name.endsWith(`Mark`);)e=e[t];return e};n.parse(r).iterate({enter(e){switch(e.name){case`Frontmatter`:return e.node.getChildren(`FrontmatterMark`).length===2&&s.push({from:e.from,to:e.to,text:``}),!1;case`Blockquote`:{let t=i.lineAt(e.from),n=a.exec(t.text);if(n&&n[0].length<t.text.trimEnd().length){let e=t.from+n[0].length;s.push({from:e,to:e,text:`\n${n[0].slice(0,n[0].indexOf(`[`))}`})}return!0}case`Table`:{let t=l(e.node.prevSibling,`prevSibling`);t&&i.lineAt(t.to).number===i.lineAt(e.from).number-1&&c(e.node);let n=l(e.node.nextSibling,`nextSibling`);return n&&i.lineAt(n.from).number===i.lineAt(e.to).number+1&&c(n),!0}case`TableRow`:return e.node.getChild(`TableDelimiter`)||s.push({from:e.from,to:e.from,text:`| `},{from:e.to,to:e.to,text:` |`}),!0;case`InlineMath`:case`BlockMath`:{let n=t(i,e.node);for(let t=e.node.parent;t;t=t.parent)t.name===`Table`&&(n=n.replace(/\\\|/g,`|`));let r=e.name===`BlockMath`?`pre`:`span`;return s.push({from:e.from,to:e.to,text:`<${r} data-x-math="${o.length}"></${r}>`}),o.push({tex:n,display:e.name===`BlockMath`}),!1}default:return!0}}});let u=[],f=0;for(let e of s.sort((e,t)=>e.from-t.from))u.push(r.slice(f,e.from),e.text),f=e.to;return u.push(r.slice(f)),{md:u.join(``),formulas:o}}var be=`gfm+east_asian_line_breaks-tex_math_dollars-tex_math_gfm-emoji-yaml_metadata_block`,xe=`<style>$highlighting-css$</style>
$body$
`,X=`highlight.theme`;async function Z(e,t,n,r,i){let{md:a,formulas:o}=ye(t),{stdout:s}=await e({options:{from:be,to:`html5`,standalone:!0,template:`export.html`,wrap:`none`,"syntax-highlighting":X},stdin:a,files:{"export.html":xe,[X]:S}}),c=new DOMParser().parseFromString(s,`text/html`);return await Se(c,n,r,i),De(c),{doc:c,formulas:o}}async function Se(e,t,n,i){let a=new Map;for(let t of e.querySelectorAll(`picture > source`))t.remove();await Promise.all(Array.from(e.images,async e=>{let o=(e.getAttribute(`src`)??``).trim(),s=t?r(t.path,o):null,c;if(t&&s!==null)c=()=>(t.readBlob??l)(t.conversationId,s);else if(/^data:/i.test(o)||n&&/^(https?:)?\/\//i.test(o))c=()=>Ce(o);else return;let u=s??o,d=a.get(u);d||(d=c().then(async e=>i(e,await we(e))),a.set(u,d)),e.setAttribute(`src`,await d),e.removeAttribute(`srcset`)}))}async function Ce(e){let t=await fetch(e,{credentials:`omit`});if(!t.ok)throw Error(`Image ${e} returned ${t.status}`);return t.blob()}async function we(e){let t=URL.createObjectURL(e);try{let e=new Image;return e.src=t,await e.decode(),e}finally{URL.revokeObjectURL(t)}}async function Te(e){return new Promise((t,n)=>{let r=new FileReader;r.onload=()=>t(String(r.result)),r.onerror=()=>n(r.error),r.readAsDataURL(e)})}var Ee=Object.keys(s);function De(e){for(let t of Ee)for(let n of e.querySelectorAll(`div.${t}`)){let r=n.firstElementChild;if(!r?.classList.contains(`title`))continue;let i=e.createElement(`strong`);i.textContent=s[t].label();let a=e.createElement(`p`);a.append(i),r.replaceChildren(a),n.classList.add(`md-callout`)}}function Oe(e,t){for(let n of e.querySelectorAll(`[data-x-math]`)){let r=t[Number(n.getAttribute(`data-x-math`))];if(!r)continue;let a=e.createElement(r.display?`div`:`span`);a.className=r.display?`md-math md-math-block`:`md-math`,i(a,r.tex,r.display),n.replaceWith(a)}}var Q=/\\(tag|notag|nonumber)\b/;function ke(e,t,n){let r=e.ownerDocument;for(let i of e.querySelectorAll(`[data-x-math]`)){let e=t[Number(i.getAttribute(`data-x-math`))];e&&i.replaceWith(n(e)?je(r,e):Ae(r,e))}}function Ae(e,{tex:t,display:n}){let r=e.createElement(`script`);return r.type=n?`math/tex; mode=display`:`math/tex`,r.textContent=t,r}function je(e,t){try{let n=e.createElement(`span`);return n.innerHTML=c.renderToString(t.tex,{displayMode:t.display,output:`mathml`,throwOnError:!0,strict:`ignore`}),n.querySelector(`annotation`)?.remove(),n}catch{return Ae(e,t)}}var $=e=>e.replace(/\.[^.]+$/,``);function Me(t,n){e(new Blob([t],{type:`text/plain;charset=utf-8`}),`${$(n)}.txt`)}var Ne=[[`png`,[137,80,78,71]],[`jpg`,[255,216,255]],[`gif`,[71,73,70,56]]];async function Pe(e,t){let n=new Uint8Array(await e.slice(0,4).arrayBuffer()),r=Ne.find(([,e])=>e.every((e,t)=>n[t]===e));if(r)return{data:e,extension:r[0]};if(e.type.split(`;`)[0].trim().toLowerCase()===`image/svg+xml`)return{data:e,extension:`svg`};let i=document.createElement(`canvas`);i.width=t.naturalWidth,i.height=t.naturalHeight,i.getContext(`2d`).drawImage(t,0,0);let a=await new Promise(e=>i.toBlob(e,`image/png`));if(!a)throw Error(`Image could not be converted`);return{data:a,extension:`png`}}async function Fe(t,n,r){let i=await J(async e=>{let n={},{doc:i,formulas:a}=await Z(e,t,r,!0,async(e,t)=>{let{data:r,extension:i}=await Pe(e,t),a=`x-export-image-${Object.keys(n).length}.${i}`;return n[a]=r,a}),o={"reference.docx":he(),[X]:S},s=async t=>{let r=i.body.cloneNode(!0);ke(r,a,t),le(r);for(let e of r.querySelectorAll(`input[type="checkbox"]`))e.replaceWith(e.hasAttribute(`checked`)?`☒ `:`☐ `);for(let e of r.querySelectorAll(`iframe`))e.remove();return e({options:{from:`html`,to:`docx`,"output-file":`export.docx`,"reference-doc":`reference.docx`,"syntax-highlighting":X},stdin:r.innerHTML,files:{...n,...o}})},c=await s(e=>Q.test(e.tex)),l=new Set(c.warnings.filter(e=>e.type===`CouldNotConvertTeXMath`).map(e=>e.contents));l.size&&(c=await s(e=>Q.test(e.tex)||l.has(e.tex)));let u=c.warnings.find(e=>e.type===`CouldNotFetchResource`);if(u)throw Error(u.pretty??`Image could not be embedded`);if(!c.file)throw Error(`Pandoc produced no document`);return _e(c.file)});e(new Blob([i],{type:`application/vnd.openxmlformats-officedocument.wordprocessingml.document`}),`${$(n)}.docx`)}async function Ie(e,t,n){let[{doc:r,formulas:i},{default:a},{default:o}]=await Promise.all([J(t=>Z(t,e,n,!1,Te)),u(()=>import(`./katex.min-CPH3Qo-l.js`),[]),u(()=>import(`./inter-CdFFsFF0.js`),[])]);Oe(r,i),re(r);let s=Array.from(r.head.querySelectorAll(`style, link[rel="stylesheet"]`),e=>e.outerHTML).join(``);return`<!doctype html><html><head><meta charset="utf-8"><title>${Le(t)}</title><style>${o}</style><style>${ne}</style><style>${a}</style>${s}</head><body><div class="md-export">${r.body.innerHTML}</div></body></html>`}function Le(e){return e.replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`).replace(/"/g,`&quot;`)}async function Re(e,t,n){let r=$(t),i,a=document.createElement(`iframe`);a.setAttribute(`sandbox`,`allow-same-origin allow-modals`),a.setAttribute(`aria-hidden`,`true`),a.style.position=`fixed`,a.style.right=`0`,a.style.bottom=`0`,a.style.width=`688px`,a.style.height=`0`,a.style.border=`0`,document.body.appendChild(a);let o=!1,s,c=()=>{o||(o=!0,clearTimeout(s),a.remove(),i!==void 0&&(document.title=i))},l;try{l=await Ie(e,r,n)}catch(e){throw c(),e}await new Promise((e,t)=>{let n=e=>{c(),t(e)};a.onload=async()=>{a.onload=null;try{let t=a.contentWindow;if(!t)throw Error(`Print frame is unavailable`);await Promise.all(Array.from(t.document.images,e=>e.decode())),t.document.body.getBoundingClientRect(),await t.document.fonts.ready;let n=t.document.querySelector(`.md-export`);for(let e of n.querySelectorAll(`.md-table`)){let t=e.querySelector(`table`);t&&t.getBoundingClientRect().width>e.clientWidth+1&&t.classList.add(`md-wide`)}for(let e of n.querySelectorAll(`.katex-display`))e.scrollWidth>e.clientWidth+1&&(e.style.fontSize=`${(e.clientWidth/e.scrollWidth).toFixed(3)}em`);t.addEventListener(`afterprint`,c,{once:!0}),i=document.title,document.title=r,s=setTimeout(c,6e4),t.focus(),t.print(),e()}catch(e){n(e)}};try{let e=a.contentWindow?.document??a.contentDocument;if(!e)throw Error(`Print document is unavailable`);e.open(),e.write(l),e.close()}catch(e){n(e)}})}export{Fe as downloadAsDocx,Me as downloadAsTxt,Re as printAsPdf};