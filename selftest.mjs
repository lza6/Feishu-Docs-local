/**
 * 自检：不联网、不依赖浏览器，只验证纯逻辑部分。
 *
 *   node selftest.mjs        （等价 npm run selftest）
 *
 * 覆盖：富文本 attribs 解码、资源扩展名嗅探与命名、block_map → HTML/Markdown 渲染、
 * 资源落盘。真实抓取链路需要浏览器 + 已登录会话，不在本文件范围内。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sniffExt, assetFileName, decodeInline, plainText, render, writeAssets } from './lib/render.mjs';

// ---------------- 富文本解码 ----------------

test('decodeInline 按 attribs 切分文本段落', () => {
  const textObj = {
    initialAttributedTexts: {
      text: { 0: 'HelloWorld' },
      attribs: { 0: '*0*1+5*5+5' }
    },
    apool: { numToAttrib: { 1: ['bold', 'true'] } }
  };
  const segs = decodeInline(textObj);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], { text: 'Hello', attrs: [['bold', 'true']] });
  assert.deepEqual(segs[1], { text: 'World', attrs: [] });
});

test('decodeInline 支持 | 分隔符（与 + 等价）', () => {
  const textObj = {
    initialAttributedTexts: { text: { 0: 'abcd' }, attribs: { 0: '*0|4' } },
    apool: { numToAttrib: {} }
  };
  assert.deepEqual(decodeInline(textObj), [{ text: 'abcd', attrs: [] }]);
});

test('decodeInline 在 attribs 总长与文本不符时回退为整段纯文本', () => {
  const textObj = {
    initialAttributedTexts: { text: { 0: 'abc' }, attribs: { 0: '*0+2' } },
    apool: { numToAttrib: {} }
  };
  assert.deepEqual(decodeInline(textObj), [{ text: 'abc', attrs: [] }]);
});

test('decodeInline / plainText 对缺失或空输入返回空', () => {
  assert.deepEqual(decodeInline(null), []);
  assert.deepEqual(decodeInline({}), []);
  assert.deepEqual(decodeInline({ initialAttributedTexts: { text: {} } }), []);
  assert.equal(plainText(undefined), '');
  assert.equal(
    plainText({ initialAttributedTexts: { text: { 0: '无属性' } } }),
    '无属性'
  );
});

// ---------------- 资源扩展名 ----------------

test('sniffExt 按文件头识别真实格式', () => {
  assert.equal(sniffExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])), '.png');
  assert.equal(sniffExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), '.jpg');
  assert.equal(sniffExt(Buffer.from('GIF89a', 'ascii')), '.gif');
  const webp = Buffer.alloc(16);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  assert.equal(sniffExt(webp), '.webp');
  assert.equal(sniffExt(Buffer.from('%PDF-1.7', 'ascii')), '.pdf');
});

test('sniffExt 无法识别时返回 null（空 Buffer 不越界）', () => {
  assert.equal(sniffExt(Buffer.alloc(0)), null);
  assert.equal(sniffExt(Buffer.from('not-an-image', 'ascii')), null);
});

test('assetFileName 优先级：原文件名 > 字节嗅探 > content-type', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  // 1) 原文件名（含非法字符会被替换）
  assert.equal(assetFileName('tok', 'image/png', 'a/b:c.png', png), 'a_b_c.png');
  // 2) 白板接口标 png 实为 jpeg → 以真实字节为准
  assert.equal(assetFileName('tok', 'image/png', 'noext', Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'tok.jpg');
  // 3) 嗅探不出来时退回 content-type
  assert.equal(assetFileName('tok', 'application/pdf', undefined, Buffer.from('xx')), 'tok.pdf');
  assert.equal(assetFileName('tok', 'image/webp', '', Buffer.alloc(0)), 'tok.webp');
});

// ---------------- 渲染 ----------------

/** 构造一份最小但结构完整的 block_map，覆盖主类型与边界 */
function fixture() {
  const state = (t, extra = {}) => ({ data: { type: t, ...extra } });
  const bm = {
    root: state('page', { children: ['h1', 'p1', 'li1', 'li2', 'tbl', 'img1', 'imgMissing', 'code1', 'callout1', 'file1', 'ghost'] }),
    h1: state('heading1', { text: { initialAttributedTexts: { text: { 0: '一级标题' } } } }),
    // 三段：普通(粗体) + 粗体(内联代码) + 与代码(无属性)，长度 2+2+3 必须等于文本长度
    p1: state('text', {
      text: {
        initialAttributedTexts: { text: { 0: '普通粗体与代码' }, attribs: { 0: '*0*1+2*2*2+2*4+3' } },
        apool: { numToAttrib: { 1: ['bold', 'true'], 2: ['inlineCode', 'true'] } }
      }
    }),
    li1: state('bullet', { text: { initialAttributedTexts: { text: { 0: '项一' } } } }),
    li2: state('ordered', { text: { initialAttributedTexts: { text: { 0: '项二' } } } }),
    tbl: state('table', {
      rows_id: ['r1', 'r2'],
      columns_id: ['c1', 'c2'],
      cell_set: {
        r1c1: { block_id: 'cell11', merge_info: { row_span: 1, col_span: 2 } },
        r2c1: { block_id: 'cell21', merge_info: { row_span: 1, col_span: 1 } },
        r2c2: { block_id: 'cell22', merge_info: { row_span: 1, col_span: 1 } }
      }
    }),
    // 真实结构：table_cell 块不直接带 text，而是 children 指向 text 块
    cell11: state('table_cell', { children: ['t11'] }),
    cell21: state('table_cell', { children: ['t21'] }),
    cell22: state('table_cell', { children: ['t22'] }),
    t11: state('text', { text: { initialAttributedTexts: { text: { 0: '合并表头' } } } }),
    t21: state('text', { text: { initialAttributedTexts: { text: { 0: 'A' } } } }),
    t22: state('text', { text: { initialAttributedTexts: { text: { 0: 'B' } } } }),
    img1: state('image', {
      image: { token: 'tokImg', caption: { text: { initialAttributedTexts: { text: { 0: '图注' } } } } }
    }),
    imgMissing: state('image', { image: { token: 'tokMissing' } }),
    code1: state('code', {
      language: 'Python',
      text: { initialAttributedTexts: { text: { 0: 'print(1)\nprint(2)' } } }
    }),
    callout1: state('callout', { emoji_value: '1f4a1', children: ['calloutText'] }),
    calloutText: state('text', { text: { initialAttributedTexts: { text: { 0: '提示内容' } } } }),
    file1: state('file', { file: { token: 'tokFile', name: 'cfg_data.py', size: 2048 } })
  };
  // ghost 故意不在 bm 中，用于验证 childrenOf 会过滤掉悬空引用
  return { block_map: bm, docId: 'root', assets: { tokImg: { file: 'tokImg.png', ct: 'image/png' }, tokFile: { file: 'cfg_data.py', ct: 'text/plain' } },
    meta: { title: '测试文档', sourceUrl: 'https://x.feishu.cn/docx/TEST', exportedAt: '2026-01-01 00:00:00' } };
}

test('render 生成 HTML：标题层级、行内样式、表格合并、资源与缺失资源', () => {
  const { html, toc, stats } = render(fixture());

  assert.match(html, /<h2 id="h1">一级标题<\/h2>/);
  // 行内属性：粗体 + 内联代码
  assert.match(html, /<strong>普通<\/strong>/);
  assert.match(html, /<code>粗体<\/code>/);
  assert.match(html, /与代码/);
  // 列表：连续同类项合并为 ul/ol
  assert.match(html, /<ul><li id="li1">项一<\/li><\/ul>/);
  assert.match(html, /<ol><li id="li2">项二<\/li><\/ol>/);
  // 表格：colspan 合并与内容（单元格内容按 text 块渲染为 <p>）
  assert.match(html, /<td colspan="2"><p>合并表头<\/p><\/td>/);
  assert.match(html, /<td><p>A<\/p><\/td><td><p>B<\/p><\/td>/);
  // 图片本地化 + 图注
  assert.match(html, /<img src="assets\/tokImg\.png"[^>]*><figcaption>图注<\/figcaption>/);
  // 缺失资源不得静默丢失，必须显式标注
  assert.match(html, /［资源缺失：tokMissing］/);
  // 代码块语言与转义
  assert.match(html, /<pre class="code" data-lang="Python">/);
  // 附件带下载链接与大小
  assert.match(html, /<a href="assets\/cfg_data\.py" download>cfg_data\.py<\/a>/);
  assert.match(html, /\(2 KB\)/);
  // callout emoji 从 code point 还原
  assert.match(html, /💡/);
  // 元信息与目录
  assert.match(html, /<title>测试文档<\/title>/);
  assert.match(html, /来源：<a href="https:\/\/x\.feishu\.cn\/docx\/TEST">/);
  assert.deepEqual(toc, [{ id: 'h1', level: 1, text: '一级标题' }]);
  assert.equal(stats.tocEntries, 1);
  // 渲染产物不得出现 undefined / NaN / [object Object]
  assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/);
});

test('render 生成 Markdown：标题偏移、列表标记、表格、代码栅栏、图片与附件', () => {
  const { md } = render(fixture());

  assert.match(md, /^# 测试文档/);
  assert.match(md, /## 一级标题/);
  assert.match(md, /\*\*普通\*\*`粗体`与代码/);
  assert.match(md, /- 项一/);
  assert.match(md, /1\. 项二/);
  assert.match(md, /\| 合并表头 \|/);
  assert.match(md, /\| A \| B \|/);
  assert.match(md, /```python\nprint\(1\)\nprint\(2\)\n```/);
  assert.match(md, /!\[图注\]\(assets\/tokImg\.png\)/);
  assert.match(md, /📎 附件：\[cfg_data\.py\]\(assets\/cfg_data\.py\)/);
  // 缺失资源的图片在 Markdown 中直接省略，不产生坏链接
  assert.doesNotMatch(md, /tokMissing/);
  assert.doesNotMatch(md, /undefined|NaN|\[object Object\]/);
});

test('render 对空文档不抛异常', () => {
  const out = render({ block_map: { root: { data: { type: 'page' } } }, docId: 'root', assets: {}, meta: {} });
  assert.equal(out.toc.length, 0);
  assert.match(out.html, /<title>飞书文档<\/title>/);
  assert.equal(out.md.trim().split('\n')[0], '# 飞书文档');
});

// ---------------- 资源落盘 ----------------

test('writeAssets 按真实字节决定落盘扩展名，跳过失败项', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-selftest-'));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const written = writeAssets(dir, {
      tokPng: { ok: true, b64: png.toString('base64'), ct: 'image/png', kind: 'image' },
      tokBad: { ok: false, b64: '', ct: 'image/png', kind: 'image' }
    });

    assert.deepEqual(Object.keys(written), ['tokPng']);
    assert.equal(written.tokPng.file, 'tokPng.png');
    assert.equal(written.tokPng.size, png.length);
    const onDisk = fs.readFileSync(path.join(dir, 'assets', 'tokPng.png'));
    assert.deepEqual(onDisk, png);
    assert.equal(fs.existsSync(path.join(dir, 'assets', 'tokBad.png')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
