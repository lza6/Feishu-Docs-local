/**
 * 渲染器缺陷回归用例 —— 对应 docs/计划书/下一步改进指南.md 的 P0-1 / P1-6 / P2-4。
 * 全部无浏览器、无网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../lib/render.mjs';

const state = (t, extra = {}) => ({ data: { type: t, ...extra } });
const txt = s => ({ initialAttributedTexts: { text: { 0: s } } });

// ---------------- P0-1 未支持块不得静默丢弃 ----------------

test('P0-1：无内容的未支持块必须显式占位（HTML 与 Markdown 都要）', () => {
  const bm = {
    root: state('page', { children: ['p1', 'media1', 'sheet1', 'bitable1'] }),
    p1: state('text', { text: txt('正文可见') }),
    media1: state('media', { file_token: 'tokFile1' }),
    sheet1: state('sheet', { token: 'tokSheet' }),
    bitable1: state('bitable', {})
  };
  const o = render({ block_map: bm, docId: 'root', assets: {}, meta: { title: 'T' } });

  // 三种未支持块都必须出现在正文里，而不是凭空消失
  assert.match(o.html, /［未支持块：media］/);
  assert.match(o.html, /［未支持块：sheet］/);
  assert.match(o.html, /［未支持块：bitable］/);
  assert.match(o.md, /［未支持块：media］/);

  assert.equal(o.unsupported.length, 3);
  assert.deepEqual(o.unsupported.map(u => u.type).sort(), ['bitable', 'media', 'sheet']);
  assert.match(o.html, /正文可见/);
});

test('P0-1：占位保留 token，便于人工追查缺失内容', () => {
  const bm = {
    root: state('page', { children: ['media1'] }),
    media1: state('media', { file_token: 'tokFileABC' })
  };
  const o = render({ block_map: bm, docId: 'root', assets: {}, meta: {} });
  assert.match(o.html, /data-token="tokFileABC"/);
  assert.equal(o.unsupported[0].token, 'tokFileABC');
});

test('P0-1：块总数与实渲染块数分开统计，不得用单一数字暗示完整', () => {
  const bm = {
    root: state('page', { children: ['p1', 'media1', 'media2'] }),
    p1: state('text', { text: txt('正文') }),
    media1: state('media', {}),
    media2: state('media', {})
  };
  const o = render({ block_map: bm, docId: 'root', assets: {}, meta: {} });
  assert.equal(o.stats.blocks, 4, 'blocks 是输入总数');
  assert.equal(o.stats.unsupportedCount, 2);
  assert.ok(o.stats.renderedBlocks >= 1, 'renderedBlocks 统计真实产出的块');
  assert.notEqual(o.stats.blocks, o.stats.renderedBlocks);
});

test('P0-1：有文本但未专门支持的块降级为段落，内容不丢且被记录', () => {
  const bm = {
    root: state('page', { children: ['weird1'] }),
    weird1: state('some_future_type', { text: txt('这段文字不能丢') })
  };
  const o = render({ block_map: bm, docId: 'root', assets: {}, meta: {} });
  assert.match(o.html, /这段文字不能丢/);
  assert.equal(o.degraded.length, 1);
  assert.equal(o.degraded[0].type, 'some_future_type');
  assert.equal(o.unsupported.length, 0);
});

// ---------------- P1-6 单块异常不炸整篇 ----------------

test('P1-6：单块渲染抛异常时隔离，其余内容照常产出（HTML + MD）', () => {
  const bm = {
    root: state('page', { children: ['code1', 'p1'] }),
    // language 不是字符串 → blockMdInner 抛 TypeError（HTML 侧因 esc 兜底不抛）
    code1: state('code', { language: { weird: true }, text: txt('print(1)') }),
    p1: state('text', { text: txt('后续内容仍在') })
  };
  const o = render({ block_map: bm, docId: 'root', assets: {}, meta: {} });

  assert.equal(o.renderErrors.length, 1, '异常块被记录（两侧共用按 id 去重）');
  assert.equal(o.renderErrors[0].type, 'code');
  assert.match(o.md, /［渲染失败块：code/);
  assert.match(o.html, /后续内容仍在/, '其它块必须正常渲染');
  assert.match(o.md, /后续内容仍在/);
});

test('P1-6：非法 emoji code point 回退为默认图标，不抛异常', () => {
  const bm = {
    root: state('page', { children: ['c1'] }),
    c1: state('callout', { emoji_value: 'not-hex', children: ['ct'] }),
    ct: state('text', { text: txt('提示内容') })
  };
  let o;
  assert.doesNotThrow(() => { o = render({ block_map: bm, docId: 'root', assets: {}, meta: {} }); });
  assert.equal(o.renderErrors.length, 0);
  assert.match(o.html, /💡/);
  assert.match(o.html, /提示内容/);
});

// ---------------- P2-4 语义块降级 ----------------

test('P2-4：todo 渲染为勾选状态，heading6+ 渲染为标题而非普通段落', () => {
  const bm = {
    root: state('page', { children: ['todo1', 'todo2', 'h6'] }),
    todo1: state('todo', { done: true, text: txt('已完成项') }),
    todo2: state('todo', { done: false, text: txt('未完成项') }),
    h6: state('heading6', { text: txt('六级标题') })
  };
  const o = render({ block_map: bm, docId: 'root', assets: {}, meta: {} });
  assert.match(o.html, /☑ 已完成项/);
  assert.match(o.html, /☐ 未完成项/);
  assert.match(o.html, /<h6 class="h-deep" id="h6">六级标题<\/h6>/);
  assert.equal(o.stats.unsupportedCount, 0);
});

// ---------------- 不回归：原有正常路径 ----------------

test('P0-1：children 指向不存在的块时必须被记录，不得静默过滤', () => {
  const bm = {
    root: state('page', { children: ['p1', 'ghost1', 'ghost2'] }),
    p1: state('text', { text: txt('可见内容') })
  };
  const o = render({ block_map: bm, docId: 'root', assets: {}, meta: {} });
  assert.equal(o.danglingRefs.length, 2, '两个悬空引用都要被记录');
  assert.deepEqual(o.danglingRefs.map(d => d.child), ['ghost1', 'ghost2']);
  assert.equal(o.stats.danglingCount, 2);
  assert.match(o.html, /可见内容/, '正常内容不受影响');
});

test('P0-1：同一悬空引用被多次遍历时不重复计数', () => {
  const bm = {
    root: state('page', { children: ['box', 'ghost1'] }),
    box: state('callout', { children: ['ghost1'] })
  };
  const o = render({ block_map: bm, docId: 'root', assets: {}, meta: {} });
  assert.equal(o.danglingRefs.length, 2, 'root>ghost1 与 box>ghost1 是两条不同引用');
  // 同一条引用重复遍历只记一次
  const dup = render({ block_map: bm, docId: 'root', assets: {}, meta: {} });
  assert.equal(dup.danglingRefs.length, 2);
});

test('常规文档不产生任何告警型记录（unsupported/degraded/renderErrors 全空）', () => {
  const bm = {
    root: state('page', { children: ['h1', 'p1'] }),
    h1: state('heading1', { text: txt('标题') }),
    p1: state('text', { text: txt('正文') })
  };
  const o = render({ block_map: bm, docId: 'root', assets: {}, meta: {} });
  assert.equal(o.unsupported.length, 0);
  assert.equal(o.degraded.length, 0);
  assert.equal(o.renderErrors.length, 0);
  assert.equal(o.stats.unsupportedCount, 0);
  assert.ok(o.stats.renderedBlocks >= 2);
});
