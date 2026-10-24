/**
 * 抓取层缺陷回归用例 —— 对应改进指南 P1-2 / P1-3 / P1-4 / P1-7。
 *
 * captureDoc 是"注入页面执行"的函数，这里在 Node 里模拟 window / document /
 * FileReader / fetch 后直接调用，因此**不需要浏览器、不需要网络**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureDoc } from '../lib/capture.mjs';

class FakeFileReader {
  readAsDataURL(blob) {
    queueMicrotask(() => {
      this.result = `data:application/octet-stream;base64,${blob.__b64 || ''}`;
      this.onload();
    });
  }
}

const mkRes = ({ ok = true, status = 200, ct = 'image/png', json = null, size = 8, b64 = 'QUJD' }) => ({
  ok,
  status,
  headers: { get: k => (String(k).toLowerCase() === 'content-type' ? ct : null) },
  json: async () => json,
  blob: async () => ({ size, __b64: b64 })
});

const imageBlock = token => ({ data: { type: 'image', image: { token } } });
const textBlock = s => ({ data: { type: 'text', text: { initialAttributedTexts: { text: { 0: s } } } } });

/** 安装页面环境；pages 按顺序喂给 client_vars，最后一个会被重复使用 */
function installEnv(pages, assetHandler) {
  let idx = 0;
  globalThis.window = {};
  globalThis.document = { title: 'Fake' };
  globalThis.FileReader = FakeFileReader;
  globalThis.fetch = async url => {
    if (String(url).includes('client_vars')) {
      const p = pages[Math.min(idx++, pages.length - 1)];
      return mkRes({ ct: 'application/json', json: { code: 0, data: p } });
    }
    return assetHandler ? assetHandler(url) : mkRes({});
  };
}

const onePage = (bm, extra = {}) => [{ block_map: bm, has_more: false, ...extra }];

// ---------------- P1-2 探查必须带回资源清单 ----------------

test('P1-2：探查调用（chunkIndexes=null）返回完整资源清单且不下载', async () => {
  installEnv(onePage({
    root: { data: { type: 'page', children: ['i1', 'i2'] } },
    i1: imageBlock('tokA'),
    i2: imageBlock('tokB')
  }));
  const r = await captureDoc('root', null, 8);

  assert.equal(r.assetTotal, 2);
  // 原实现此处为 undefined，导致 manifest.assets.missing 恒为 []
  assert.ok(Array.isArray(r.assets), 'assets 必须是数组');
  assert.deepEqual(r.assets.map(a => a.token), ['tokA', 'tokB']);
  assert.deepEqual(r.assetPayload, {}, '探查阶段不得下载资源');
  assert.equal(r.assetDone, 0);
  assert.equal(r.title, 'Fake');
});

test('P1-2：空数组参数表示"什么都不做"，也不下载', async () => {
  installEnv(onePage({
    root: { data: { type: 'page', children: ['i1'] } },
    i1: imageBlock('tokA')
  }));
  const r = await captureDoc('root', [], 8);
  assert.deepEqual(r.assetPayload, {});
  assert.equal(r.assetDone, 0);
});

// ---------------- P1-3 分批只回传本批 + 体积上限 ----------------

test('P1-3：分批下载时 assetPayload 只含本批新增，不重复回传历史批次', async () => {
  installEnv(onePage({
    root: { data: { type: 'page', children: ['i1', 'i2', 'i3', 'i4'] } },
    i1: imageBlock('t0'), i2: imageBlock('t1'), i3: imageBlock('t2'), i4: imageBlock('t3')
  }));
  const r0 = await captureDoc('root', [0], 2);
  const r1 = await captureDoc('root', [1], 2);

  assert.deepEqual(Object.keys(r0.assetPayload).sort(), ['t0', 't1']);
  // 原实现会把 t0..t3 全部再塞一遍（O(n²)）
  assert.deepEqual(Object.keys(r1.assetPayload).sort(), ['t2', 't3']);
  assert.equal(r1.assetDone, 4, 'assetDone 仍统计全局已完成数');
});

test('P1-3：单资源超过上限时跳过并记入 skippedAssets（上限可配）', async () => {
  installEnv(
    onePage({
      root: { data: { type: 'page', children: ['big1'] } },
      big1: { data: { type: 'file', file: { token: 'tokBig', name: 'huge.zip' } } }
    }),
    () => mkRes({ ct: 'application/octet-stream', size: 2048 })
  );
  // 上限设为 1KB，使 2KB 的 mock 资源触发跳过
  const r = await captureDoc('root', [0], 8, 1024);

  assert.equal(r.assetDone, 0);
  assert.deepEqual(r.assetPayload, {}, '超限资源不得进入 payload');
  assert.equal(r.skippedAssets.length, 1);
  assert.equal(r.skippedAssets[0].token, 'tokBig');
});

// ---------------- P1-4 分页截断必须暴露 ----------------

test('P1-4：达到 200 页上限仍未取完 → truncated=true，不再静默', async () => {
  let n = 0;
  globalThis.window = {};
  globalThis.document = { title: 'Fake' };
  globalThis.FileReader = FakeFileReader;
  globalThis.fetch = async url => {
    if (String(url).includes('client_vars')) {
      n++;
      return mkRes({
        ct: 'application/json',
        json: {
          code: 0,
          data: { block_map: { [`b${n}`]: textBlock('x') }, has_more: true, next_cursors: [`c${n}`] }
        }
      });
    }
    return mkRes({});
  };

  const r = await captureDoc('b1', null, 8);
  assert.equal(r.truncated, true);
  assert.equal(r.pagesFetched, 200);
});

test('正常分页：多页合并，取完即停，不误报截断', async () => {
  installEnv([
    {
      block_map: { root: { data: { type: 'page', children: ['p1'] } }, p1: textBlock('第一页') },
      has_more: true,
      next_cursors: ['c2']
    },
    {
      block_map: { p2: textBlock('第二页') },
      has_more: false
    }
  ]);
  const r = await captureDoc('root', null, 8);
  assert.equal(r.truncated, false);
  assert.equal(r.pagesFetched, 2);
  assert.equal(r.blockCount, 3);
});

// ---------------- P1-7 media 资源采集 ----------------

test('P1-7：media 块（视频/音频）进入资源采集清单', async () => {
  installEnv(onePage({
    root: { data: { type: 'page', children: ['m1'] } },
    m1: { data: { type: 'media', file_token: 'tokVideo', file_name: 'demo.mp4' } }
  }));
  const r = await captureDoc('root', null, 8);
  assert.equal(r.assets.length, 1);
  assert.equal(r.assets[0].kind, 'media');
  assert.equal(r.assets[0].token, 'tokVideo');
  assert.equal(r.assets[0].name, 'demo.mp4');
});

// ---------------- 错误路径 ----------------

test('接口返回 HTTP 错误时抛可读异常，不静默返回空结果', async () => {
  globalThis.window = {};
  globalThis.document = { title: 'Fake' };
  globalThis.FileReader = FakeFileReader;
  globalThis.fetch = async () => mkRes({ ok: false, status: 403, ct: 'application/json', json: {} });

  await assert.rejects(() => captureDoc('root', null, 8), /HTTP 403/);
});

test('完全取不到内容块时抛错（提示可能未登录）', async () => {
  installEnv([{ block_map: {}, has_more: false }]);
  await assert.rejects(() => captureDoc('root', null, 8), /未取到任何内容块/);
});
