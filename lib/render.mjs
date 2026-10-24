/**
 * 把飞书 docx 的 block 数据渲染成独立 HTML + Markdown。
 * 输入：{ docId, block_map, assets: { token: { file, ct } }, meta }
 */
import fs from 'node:fs';
import path from 'node:path';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const EXT_BY_MIME = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'application/pdf': '.pdf'
};

/** 以文件头嗅探真实图片格式（飞书白板接口会标 png 实为 jpeg） */
export function sniffExt(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length > 3 && buf.slice(0, 3).toString('ascii') === 'GIF') return '.gif';
  if (buf.length > 12 && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (buf.length > 4 && buf.slice(0, 4).toString('ascii') === '%PDF') return '.pdf';
  return null;
}

/** 给出资源落盘文件名：优先原文件名，其次按真实字节嗅探，最后按 content-type */
export function assetFileName(token, ct, originalName, buf) {
  if (originalName && /\.[A-Za-z0-9]{1,8}$/.test(originalName)) {
    return originalName.replace(/[\\/:*?"<>|]/g, '_');
  }
  const sniffed = buf ? sniffExt(buf) : null;
  if (sniffed) return token + sniffed;
  const ext = EXT_BY_MIME[ct] ?? (ct.startsWith('image/') ? '.' + ct.split('/')[1].split(';')[0] : '');
  return token + ext;
}

// ---------------- 富文本解码 ----------------
// 飞书 attribs 形如 "*0+1i*1*2+b"：*起点(36进制) 若干 *属性下标，+长度(36进制)
export function decodeInline(textObj) {
  if (!textObj || !textObj.initialAttributedTexts) return [];
  const plain = Object.values(textObj.initialAttributedTexts.text || {}).join('');
  if (!plain) return [];
  const attrStr = (textObj.initialAttributedTexts.attribs || {})['0'] || '';
  const apool = (textObj.apool && textObj.apool.numToAttrib) || {};
  if (!attrStr) return [{ text: plain, attrs: [] }];

  const runs = [];
  const re = /\*([0-9a-z]+)((?:\*[0-9a-z]+)*)([+|])([0-9a-z]+)/g;
  let m;
  while ((m = re.exec(attrStr))) {
    const attrs = (m[2] || '').split('*').filter(Boolean).map(x => apool[String(parseInt(x, 36))] || []);
    runs.push({ len: parseInt(m[4], 36), attrs });
  }
  if (runs.reduce((s, r) => s + r.len, 0) !== plain.length) return [{ text: plain, attrs: [] }];

  const out = [];
  let pos = 0;
  for (const r of runs) {
    out.push({ text: plain.slice(pos, pos + r.len), attrs: r.attrs });
    pos += r.len;
  }
  return out;
}

const attrVal = (attrs, key) => {
  const hit = attrs.find(a => a && a[0] === key);
  return hit ? hit[1] : undefined;
};

export const plainText = textObj => decodeInline(textObj).map(s => s.text).join('');

function inlineToHtml(textObj) {
  return decodeInline(textObj).map(seg => {
    let h = esc(seg.text).replace(/\n/g, '<br>');
    const a = seg.attrs;
    if (attrVal(a, 'inlineCode')) h = `<code>${h}</code>`;
    if (attrVal(a, 'bold')) h = `<strong>${h}</strong>`;
    if (attrVal(a, 'italic')) h = `<em>${h}</em>`;
    if (attrVal(a, 'strikethrough') || attrVal(a, 'strike')) h = `<del>${h}</del>`;
    if (attrVal(a, 'underline')) h = `<u>${h}</u>`;
    const hl = attrVal(a, 'textHighlight');
    const color = attrVal(a, 'textColor');
    if (hl) h = `<span class="hl" style="background:${esc(hl)}33;color:${esc(color || '#b42318')}">${h}</span>`;
    else if (color) h = `<span style="color:${esc(color)}">${h}</span>`;
    return h;
  }).join('');
}

function inlineToMd(textObj) {
  return decodeInline(textObj).map(seg => {
    const a = seg.attrs;
    let s = seg.text;
    if (attrVal(a, 'inlineCode')) return '`' + s + '`';
    if (attrVal(a, 'bold')) s = '**' + s + '**';
    if (attrVal(a, 'strikethrough') || attrVal(a, 'strike')) s = '~~' + s + '~~';
    return s;
  }).join('');
}

// ---------------- 渲染器 ----------------
export function render({ block_map, docId, assets, meta = {} }) {
  const bm = block_map;
  const typeOf = id => (bm[id]?.data?.type) || 'unknown';
  const childrenOf = id => (Array.isArray(bm[id]?.data?.children) ? bm[id].data.children : []).filter(c => bm[c]);

  const assetHref = token => (assets[token] ? `assets/${assets[token].file}` : null);

  const figure = (token, caption, cls = '') => {
    const href = assetHref(token);
    if (!href) return `<p class="missing">［资源缺失：${esc(token)}］</p>`;
    const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : '';
    return `<figure class="${cls}"><img src="${esc(href)}" alt="${esc(caption || '图片')}" loading="lazy">${cap}</figure>`;
  };

  const tableHtml = id => {
    const d = bm[id].data;
    const rows = d.rows_id || [];
    const cols = d.columns_id || [];
    const cells = d.cell_set || {};
    const occupied = new Set();
    let out = '<div class="table-wrap"><table>';
    rows.forEach((r, ri) => {
      out += '<tr>';
      cols.forEach((c, ci) => {
        const key = r + c;
        if (occupied.has(key)) return;
        const cell = cells[key];
        if (!cell) { out += '<td></td>'; return; }
        const mi = cell.merge_info || { row_span: 1, col_span: 1 };
        for (let i = 0; i < mi.row_span; i++) {
          for (let j = 0; j < mi.col_span; j++) {
            if (i || j) occupied.add(`${rows[ri + i]}${cols[ci + j]}`);
          }
        }
        const span = (mi.row_span > 1 ? ` rowspan="${mi.row_span}"` : '') +
          (mi.col_span > 1 ? ` colspan="${mi.col_span}"` : '');
        out += `<td${span}>${childrenOf(cell.block_id).map(cid => blockHtml(cid, 1)).join('')}</td>`;
      });
      out += '</tr>';
    });
    return out + '</table></div>';
  };

  function blockHtml(id, depth = 0) {
    const b = bm[id];
    if (!b?.data) return '';
    const d = b.data;
    switch (d.type) {
      case 'page': return childrenOf(id).map(c => blockHtml(c, depth)).join('');
      case 'heading1': return `<h2 id="${esc(id)}">${inlineToHtml(d.text)}</h2>`;
      case 'heading2': return `<h3 id="${esc(id)}">${inlineToHtml(d.text)}</h3>`;
      case 'heading3': return `<h4 id="${esc(id)}">${inlineToHtml(d.text)}</h4>`;
      case 'heading4': return `<h5 id="${esc(id)}">${inlineToHtml(d.text)}</h5>`;
      case 'heading5': return `<h6 id="${esc(id)}">${inlineToHtml(d.text)}</h6>`;
      case 'text': {
        const inner = d.text ? inlineToHtml(d.text) : '';
        const kids = childrenOf(id).map(c => blockHtml(c, depth)).join('');
        if (!inner && !kids) return '';
        return `<p>${inner}</p>${kids}`;
      }
      case 'code': {
        const code = d.text ? plainText(d.text) : '';
        const cap = d.caption?.text ? plainText(d.caption.text).trim() : '';
        return `<pre class="code" data-lang="${esc(d.language || '')}">${cap ? `<span class="code-cap">${esc(cap)}</span>` : ''}<code>${esc(code)}</code></pre>`;
      }
      case 'table': return tableHtml(id);
      case 'image': {
        const img = d.image || {};
        const cap = img.caption?.text ? plainText(img.caption.text).trim() : '';
        return figure(img.token, cap);
      }
      case 'whiteboard':
        return figure(d.token, '飞书画板（静态导出）', 'whiteboard');
      case 'file': {
        const f = d.file || {};
        const href = assetHref(f.token);
        const name = href ? `<a href="${esc(href)}" download>${esc(f.name)}</a>` : esc(f.name);
        const size = f.size ? ` <span class="muted">(${Math.max(1, Math.round(f.size / 1024))} KB)</span>` : '';
        return `<p class="file">📎 附件：${name}${size}</p>`;
      }
      case 'callout': {
        const kids = childrenOf(id).map(c => blockHtml(c, depth)).join('');
        const emoji = d.emoji_value ? String.fromCodePoint(parseInt(d.emoji_value, 16)) : '💡';
        return `<div class="callout" style="background:${esc(d.background_color || '#f8fafc')};border-color:${esc(d.border_color || '#e2e8f0')}"><span class="callout-emoji">${emoji}</span><div>${kids}</div></div>`;
      }
      case 'quote_container':
        return `<blockquote>${childrenOf(id).map(c => blockHtml(c, depth)).join('')}</blockquote>`;
      case 'view':
        return childrenOf(id).map(c => blockHtml(c, depth)).join('');
      default: {
        const kids = childrenOf(id).map(c => blockHtml(c, depth)).join('');
        if (d.text) return `<p>${inlineToHtml(d.text)}</p>${kids}`;
        return kids;
      }
    }
  }

  // 连续列表项合并为 ol/ul
  function renderChildren(list, depth = 0) {
    let out = '';
    let i = 0;
    while (i < list.length) {
      const t = typeOf(list[i]);
      if (t === 'ordered' || t === 'bullet') {
        const tag = t === 'ordered' ? 'ol' : 'ul';
        let html = `<${tag}>`;
        while (i < list.length && typeOf(list[i]) === t) {
          const id = list[i];
          const text = bm[id].data.text ? inlineToHtml(bm[id].data.text) : '';
          const kids = childrenOf(id);
          html += `<li id="${esc(id)}">${text}${kids.length ? renderChildren(kids, depth + 1) : ''}</li>`;
          i++;
        }
        out += html + `</${tag}>`;
      } else {
        out += blockHtml(list[i], depth);
        i++;
      }
    }
    return out;
  }

  const rootChildren = childrenOf(docId);
  const toc = [];
  (function walk(list) {
    for (const id of list) {
      const t = typeOf(id);
      if (['heading1', 'heading2', 'heading3'].includes(t)) {
        toc.push({ id, level: Number(t.slice(-1)), text: plainText(bm[id].data.text) });
      }
      walk(childrenOf(id));
    }
  })(rootChildren);

  const title = meta.title || '飞书文档';
  const exportedAt = meta.exportedAt || new Date().toLocaleString('zh-CN', { hour12: false });
  const bodyHtml = renderChildren(rootChildren, 0);

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{--fg:#1f2328;--muted:#667085;--line:#e5e7eb;--accent:#2563eb;--code:#f6f8fa}
  *{box-sizing:border-box}html{scroll-behavior:smooth}
  body{margin:0;font:16px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:var(--fg)}
  .layout{display:flex;max-width:1280px;margin:0 auto;padding:0 20px;gap:32px}
  nav.toc{position:sticky;top:0;align-self:flex-start;max-height:100vh;overflow:auto;width:288px;flex:0 0 288px;padding:24px 0;font-size:13.5px}
  nav.toc h2{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
  nav.toc a{display:block;padding:3px 8px;color:#374151;text-decoration:none;border-left:2px solid transparent}
  nav.toc a:hover{background:#f3f4f6;color:var(--accent)}
  nav.toc a.active{color:var(--accent);border-left-color:var(--accent);background:#eff6ff;font-weight:600}
  nav.toc a.l1{font-weight:600;margin-top:6px}nav.toc a.l2{padding-left:20px}nav.toc a.l3{padding-left:34px;color:#4b5563}
  main{flex:1;min-width:0;padding:32px 0 120px}
  header.doc{border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:26px}
  header.doc h1{font-size:29px;line-height:1.32;margin:0 0 8px}
  header.doc .meta{color:var(--muted);font-size:13px}
  h2{font-size:24px;margin:42px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
  h3{font-size:19px;margin:30px 0 10px}h4{font-size:16.5px;margin:24px 0 8px}
  h5,h6{font-size:15px;margin:18px 0 6px;color:#374151}
  p{margin:10px 0}ul,ol{margin:8px 0;padding-left:26px}li{margin:4px 0}
  code{background:var(--code);padding:.15em .4em;border-radius:4px;font:.88em/1.5 "Cascadia Code",Consolas,monospace}
  pre.code{position:relative;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow:auto;margin:14px 0}
  pre.code code{background:none;padding:0;font-size:13px;line-height:1.6;white-space:pre}
  pre.code .code-cap{position:absolute;top:0;right:10px;transform:translateY(-50%);background:#fff;border:1px solid var(--line);border-radius:4px;padding:1px 8px;font-size:11.5px;color:var(--muted)}
  figure{margin:16px 0;text-align:center}figure img{max-width:100%;border:1px solid var(--line);border-radius:6px}
  figcaption{font-size:13px;color:var(--muted);margin-top:6px}
  .table-wrap{overflow:auto;margin:16px 0}table{border-collapse:collapse;width:100%;font-size:14px}
  td{border:1px solid var(--line);padding:7px 10px;vertical-align:top;text-align:left}
  tr:nth-child(2n) td{background:#fafafa}
  blockquote{margin:14px 0;padding:6px 16px;border-left:3px solid #d1d5db;background:#fcfcfd;color:#374151}
  .callout{display:flex;gap:10px;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin:16px 0}
  .file{margin:10px 0;font-size:14px}.muted{color:var(--muted)}
  .missing{color:#b42318;font-size:13px}.hl{border-radius:2px;padding:0 1px}
  a{color:var(--accent)}
  .to-top{position:fixed;right:24px;bottom:24px;background:#111827;color:#fff;border-radius:999px;padding:8px 14px;font-size:13px;text-decoration:none;opacity:.85}
  @media(max-width:900px){nav.toc{display:none}}.layout{padding-bottom:0}
  @media print{nav.toc,.to-top{display:none}pre.code,figure,table{break-inside:avoid}}
</style></head><body>
<div class="layout">
<nav class="toc"><h2>目录</h2>
${toc.map(t => `<a href="#${esc(t.id)}" class="l${t.level}">${esc(t.text)}</a>`).join('\n')}
</nav>
<main>
<header class="doc"><h1>${esc(title)}</h1>
<div class="meta">${meta.sourceUrl ? `来源：<a href="${esc(meta.sourceUrl)}">${esc(meta.sourceUrl)}</a> · ` : ''}导出时间：${esc(exportedAt)} · 离线快照，仅供本地阅读</div>
</header>
${bodyHtml}
</main></div>
<a class="to-top" href="#">↑ 顶部</a>
<script>
(function(){
  var links=[].slice.call(document.querySelectorAll('nav.toc a'));
  var targets=links.map(function(a){return document.getElementById(a.getAttribute('href').slice(1));});
  function sync(){var y=window.scrollY+120,cur=0;
    targets.forEach(function(t,i){if(t&&t.offsetTop<=y)cur=i;});
    links.forEach(function(a,i){a.classList.toggle('active',i===cur);});}
  window.addEventListener('scroll',sync,{passive:true});sync();
  [].forEach.call(document.querySelectorAll('main a[href^="http"]'),function(a){a.target='_blank';a.rel='noopener';});
})();
</script></body></html>`;

  // ---------------- Markdown ----------------
  function blockMd(id, depth = 0) {
    const b = bm[id];
    if (!b?.data) return '';
    const d = b.data;
    const pad = '  '.repeat(depth);
    switch (d.type) {
      case 'page': return mdChildren(childrenOf(id), 0);
      case 'heading1': return `\n## ${plainText(d.text)}\n\n`;
      case 'heading2': return `\n### ${plainText(d.text)}\n\n`;
      case 'heading3': return `\n#### ${plainText(d.text)}\n\n`;
      case 'heading4': return `\n##### ${plainText(d.text)}\n\n`;
      case 'heading5': return `\n###### ${plainText(d.text)}\n\n`;
      case 'text': {
        const txt = d.text ? inlineToMd(d.text) : '';
        return (txt ? pad + txt + '\n\n' : '') + mdChildren(childrenOf(id), depth);
      }
      case 'code': {
        const langMap = { 'Plain Text': 'text', 'Shell': 'bash', 'Python': 'python', 'XML': 'xml', 'YAML': 'yaml', 'JSON': 'json' };
        const lang = langMap[d.language] ?? (d.language || '').toLowerCase();
        const cap = d.caption?.text ? plainText(d.caption.text).trim() : '';
        const code = (d.text ? plainText(d.text) : '').replace(/\n+$/, '');
        return (cap ? pad + '**' + cap + '**\n\n' : '') + '```' + lang + '\n' + code + '\n```\n\n';
      }
      case 'table': {
        const rows = d.rows_id || [];
        const cols = d.columns_id || [];
        const cells = d.cell_set || {};
        const cellText = (r, c) => {
          const cell = cells[r + c];
          if (!cell) return '';
          return childrenOf(cell.block_id).map(cid => {
            const cd = bm[cid]?.data;
            if (!cd) return '';
            if (cd.type === 'image') return '[图片]';
            return cd.text ? plainText(cd.text) : '';
          }).join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
        };
        let md = '| ' + cols.map(c => cellText(rows[0], c)).join(' | ') + ' |\n';
        md += '| ' + cols.map(() => '---').join(' | ') + ' |\n';
        for (let ri = 1; ri < rows.length; ri++) md += '| ' + cols.map(c => cellText(rows[ri], c)).join(' | ') + ' |\n';
        return md + '\n';
      }
      case 'image': {
        const img = d.image || {};
        const href = assetHref(img.token);
        if (!href) return '';
        const cap = img.caption?.text ? plainText(img.caption.text).trim() : '';
        return `![${cap || '图片'}](${href})\n\n`;
      }
      case 'whiteboard': {
        const href = assetHref(d.token);
        return href ? `![飞书画板](${href})\n\n` : '';
      }
      case 'file': {
        const f = d.file || {};
        const href = assetHref(f.token);
        return `📎 附件：${href ? `[${f.name}](${href})` : f.name}\n\n`;
      }
      case 'callout':
        return '> ' + childrenOf(id).map(c => blockMd(c, 0).trim()).join('\n> ') + '\n\n';
      case 'quote_container':
        return '> ' + childrenOf(id).map(c => blockMd(c, 0).trim()).join('\n> ') + '\n\n';
      case 'view':
        return childrenOf(id).map(c => blockMd(c, depth)).join('');
      default: {
        const txt = d.text ? inlineToMd(d.text) : '';
        return (txt ? pad + txt + '\n\n' : '') + mdChildren(childrenOf(id), depth);
      }
    }
  }

  function mdChildren(list, depth) {
    let out = '';
    let i = 0;
    const pad = '  '.repeat(depth);
    while (i < list.length) {
      const t = typeOf(list[i]);
      if (t === 'ordered' || t === 'bullet') {
        let n = 1;
        while (i < list.length && typeOf(list[i]) === t) {
          const id = list[i];
          const txt = bm[id].data.text ? inlineToMd(bm[id].data.text) : '';
          const marker = t === 'ordered' ? `${n++}. ` : '- ';
          out += pad + marker + txt.replace(/\n/g, ' ') + '\n';
          const kids = childrenOf(id);
          if (kids.length) out += mdChildren(kids, depth + 1);
          i++;
        }
        out += '\n';
      } else {
        out += blockMd(list[i], depth);
        i++;
      }
    }
    return out;
  }

  const md = `# ${title}\n\n> ${meta.sourceUrl ? `来源：${meta.sourceUrl}\n> ` : ''}导出时间：${exportedAt}（离线快照，仅供本地阅读）\n\n${mdChildren(rootChildren, 0).replace(/\n{3,}/g, '\n\n')}`;

  return { html, md, toc, stats: { blocks: Object.keys(bm).length, tocEntries: toc.length } };
}

/** 把 base64 资源落盘到 <outDir>/assets */
export function writeAssets(outDir, assetData) {
  const dir = path.join(outDir, 'assets');
  fs.mkdirSync(dir, { recursive: true });
  const written = {};
  for (const [token, v] of Object.entries(assetData)) {
    if (!v.ok) continue;
    const buf = Buffer.from(v.b64, 'base64');
    const file = assetFileName(token, v.ct, v.name, buf);
    fs.writeFileSync(path.join(dir, file), buf);
    written[token] = { file, ct: v.ct, size: buf.length, kind: v.kind };
  }
  return written;
}
