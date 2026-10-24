/**
 * 本地服务契约测试 —— 起真 HTTP 服务、打真请求。
 *
 *   node --test test/server.test.mjs
 *
 * 用注入的假 runner 替代浏览器链路：验证的是「HTTP 契约 + 队列状态机 + SSE」，
 * 不证明真实飞书抓取可用（那需要浏览器与登录态，属单独的真实链路验证）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createApp } from '../server.mjs';

const VALID_URL = 'https://demo.feishu.cn/docx/AbCdEf12345';

/** 起一个测试用服务，返回 base url 与清理函数 */
async function startServer({ runner, uiDir } = {}) {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-srv-'));
  const { server, queue } = createApp({
    outRoot,
    uiDir: uiDir || path.join(outRoot, 'no-ui-dist'),
    runner
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    queue,
    outRoot,
    async close() {
      // keep-alive 连接不主动断开时 server.close() 会一直等，测试里强制关
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(outRoot, { recursive: true, force: true });
    }
  };
}

/** 默认假 runner：三个进度事件后返回结果 */
function makeRunner({ delay = 5, failWith = null } = {}) {
  const calls = [];
  const runner = async (job, ctx) => {
    calls.push({ id: job.id, startedAt: Date.now() });
    ctx.emit('navigate', { url: job.urls[0] });
    await sleep(delay);
    ctx.emit('probe', { blockCount: 3, assetTotal: 1, title: '假文档', totalChunks: 1 });
    ctx.emit('assets', { chunk: 0, totalChunks: 1, done: 1, assetTotal: 1 });
    if (failWith) throw Object.assign(new Error(failWith), { code: 'NO_CONTENT' });
    const result = { results: [{ outDir: '/fake/假文档', manifest: { title: '假文档', blockCount: 3 } }] };
    ctx.emit('done', { outDir: '/fake/假文档', manifest: result.results[0].manifest });
    return result;
  };
  return { runner, calls };
}

async function waitFor(fn, { timeout = 3000, interval = 20 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return true;
    await sleep(interval);
  }
  return false;
}

const postJson = (base, p, body) => fetch(base + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});

// ---------------- 健康检查与监听边界 ----------------

test('GET /api/health 返回 ok 且如实报告前端未构建', async () => {
  const s = await startServer({ runner: makeRunner().runner });
  try {
    const res = await fetch(s.base + '/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.port, s.server.address().port);
    assert.equal(body.ui.built, false);
    assert.equal(body.ui.stale, true);
  } finally {
    await s.close();
  }
});

test('服务只监听回环地址 127.0.0.1', async () => {
  const s = await startServer({ runner: makeRunner().runner });
  try {
    assert.equal(s.server.address().address, '127.0.0.1');
  } finally {
    await s.close();
  }
});

test('前端未构建时 GET / 返回 503 并给出构建提示', async () => {
  const s = await startServer({ runner: makeRunner().runner });
  try {
    const res = await fetch(s.base + '/');
    assert.equal(res.status, 503);
    assert.match(await res.text(), /npm --prefix ui/);
  } finally {
    await s.close();
  }
});

// ---------------- 任务创建与校验 ----------------

test('POST /api/jobs 接受合法飞书链接并最终 done', async () => {
  const s = await startServer({ runner: makeRunner().runner });
  try {
    const res = await postJson(s.base, '/api/jobs', { urls: [VALID_URL] });
    assert.equal(res.status, 201);
    const { id, status } = await res.json();
    assert.ok(id);
    assert.equal(status, 'queued');

    const done = await waitFor(() => s.queue.get(id)?.status === 'done');
    assert.ok(done, '任务应在超时内完成');
    const job = s.queue.get(id);
    assert.equal(job.phase, 'done');
    assert.deepEqual(job.result.results[0].manifest.title, '假文档');
  } finally {
    await s.close();
  }
});

test('POST /api/jobs 拒绝缺省/空/非数组 urls', async () => {
  const s = await startServer({ runner: makeRunner().runner });
  try {
    for (const body of [{}, { urls: [] }, { urls: 'x' }, { urls: [123] }]) {
      const res = await postJson(s.base, '/api/jobs', body);
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} 应被拒绝`);
    }
  } finally {
    await s.close();
  }
});

test('POST /api/jobs 拒绝非飞书域名与非法协议', async () => {
  const s = await startServer({ runner: makeRunner().runner });
  try {
    const cases = [
      ['https://evil.example.com/docx/AbC123', /飞书域名/],
      ['http://demo.feishu.cn/docx/AbC123', /https/],
      ['https://demo.feishu.cn/spreadsheet/AbC123', /文档链接/],
      ['不是URL', /合法 URL/]
    ];
    for (const [url, pattern] of cases) {
      const res = await postJson(s.base, '/api/jobs', { urls: [url] });
      assert.equal(res.status, 400, `${url} 应被拒绝`);
      assert.match((await res.json()).error, pattern);
    }
  } finally {
    await s.close();
  }
});

test('请求体超过 256KB 返回 413', async () => {
  const s = await startServer({ runner: makeRunner().runner });
  try {
    const big = JSON.stringify({ urls: [VALID_URL], pad: 'x'.repeat(300 * 1024) });
    const res = await postJson(s.base, '/api/jobs', big);
    assert.equal(res.status, 413);
  } finally {
    await s.close();
  }
});

test('非法 JSON 返回 400 而不是 500', async () => {
  const s = await startServer({ runner: makeRunner().runner });
  try {
    const res = await postJson(s.base, '/api/jobs', '{not json');
    assert.equal(res.status, 400);
  } finally {
    await s.close();
  }
});

// ---------------- 事件流 ----------------

test('SSE 依次推送 probe / assets / done 与 job:done 事件', async () => {
  const s = await startServer({ runner: makeRunner({ delay: 30 }).runner });
  const ac = new AbortController();
  try {
    const res = await fetch(s.base + '/api/events', { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const seen = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = /^event: (\S+)/m.exec(raw);
            if (ev) seen.push(ev[1]);
            const dataLine = /^data: (.*)$/m.exec(raw);
            if (dataLine && ev && ev[1] === 'job:update') {
              try { seen.push('phase:' + JSON.parse(dataLine[1]).phase); } catch { /* ignore */ }
            }
          }
        }
      } catch { /* abort 时正常结束 */ }
    })();

    await postJson(s.base, '/api/jobs', { urls: [VALID_URL] });
    const ok = await waitFor(() => seen.includes('job:done'), { timeout: 3000 });
    ac.abort();
    await pump;

    assert.ok(ok, `应收到 job:done，实际收到：${seen.join(',')}`);
    for (const expected of ['phase:navigate', 'phase:probe', 'phase:assets', 'phase:done', 'job:done']) {
      assert.ok(seen.includes(expected), `缺少事件 ${expected}；实际：${seen.join(',')}`);
    }
  } finally {
    ac.abort();
    await s.close();
  }
});

// ---------------- 取消与串行 ----------------

test('取消 queued 任务立即生效', async () => {
  const { runner } = makeRunner({ delay: 80 });
  const s = await startServer({ runner });
  try {
    const first = await (await postJson(s.base, '/api/jobs', { urls: [VALID_URL] })).json();
    const second = await (await postJson(s.base, '/api/jobs', { urls: [VALID_URL] })).json();

    // 第二个必然处于 queued（串行队列）
    assert.equal(s.queue.get(second.id).status, 'queued');
    const res = await postJson(s.base, `/api/jobs/${second.id}/cancel`, {});
    assert.equal(res.status, 202);
    assert.equal(s.queue.get(second.id).status, 'cancelled');
    // 第一个仍在跑，最终 done
    assert.ok(await waitFor(() => s.queue.get(first.id)?.status === 'done'));
  } finally {
    await s.close();
  }
});

test('队列串行：第二个任务在第一个结束前不会进入 running', async () => {
  const { runner } = makeRunner({ delay: 120 });
  const s = await startServer({ runner });
  try {
    const a = await (await postJson(s.base, '/api/jobs', { urls: [VALID_URL] })).json();
    const b = await (await postJson(s.base, '/api/jobs', { urls: [VALID_URL] })).json();

    await waitFor(() => s.queue.get(a.id)?.status === 'running');
    assert.equal(s.queue.get(a.id).status, 'running');
    assert.equal(s.queue.get(b.id).status, 'queued', '第二个任务不能与第一个并发');

    assert.ok(await waitFor(() => s.queue.get(b.id)?.status === 'done', { timeout: 4000 }));
    assert.equal(s.queue.get(a.id).status, 'done');
  } finally {
    await s.close();
  }
});

test('runner 抛错时任务落到 error 并带可读原因与 code', async () => {
  const s = await startServer({ runner: makeRunner({ failWith: '未取到内容' }).runner });
  try {
    const { id } = await (await postJson(s.base, '/api/jobs', { urls: [VALID_URL] })).json();
    assert.ok(await waitFor(() => s.queue.get(id)?.status === 'error'));
    const job = s.queue.get(id);
    assert.equal(job.error.message, '未取到内容');
    assert.equal(job.error.code, 'NO_CONTENT');
  } finally {
    await s.close();
  }
});

test('取消运行中的任务落到 cancelled', async () => {
  const s = await startServer({ runner: makeRunner({ delay: 200 }).runner });
  try {
    const { id } = await (await postJson(s.base, '/api/jobs', { urls: [VALID_URL] })).json();
    await waitFor(() => s.queue.get(id)?.status === 'running');
    const res = await postJson(s.base, `/api/jobs/${id}/cancel`, {});
    assert.equal(res.status, 202);
    assert.ok(await waitFor(() => s.queue.get(id)?.status === 'cancelled'));
  } finally {
    await s.close();
  }
});

// ---------------- 预览路由的越界防护 ----------------

test('预览路由拒绝路径穿越且不泄漏文件内容', async () => {
  const s = await startServer({ runner: makeRunner().runner });
  try {
    const attacks = [
      '/preview/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/preview/..%2f..%2f..%2f..%2fpackage.json',
      '/preview/%2e%2e/%2e%2e/package.json'
    ];
    for (const attack of attacks) {
      const res = await fetch(s.base + attack);
      assert.ok([400, 403, 404].includes(res.status), `${attack} 应被拒绝，实际 ${res.status}`);
      const text = await res.text();
      assert.doesNotMatch(text, /root:x|"name":\s*"feishu-doc-exporter"/, `${attack} 泄漏了文件内容`);
    }
  } finally {
    await s.close();
  }
});

test('预览路由能正常返回 out/ 内的产物文件', async () => {
  const s = await startServer({ runner: makeRunner().runner });
  try {
    fs.mkdirSync(path.join(s.outRoot, '某文档'), { recursive: true });
    fs.writeFileSync(path.join(s.outRoot, '某文档', 'a.html'), '<h1>hi</h1>');
    const res = await fetch(s.base + '/preview/' + encodeURIComponent('某文档') + '/a.html');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(await res.text(), '<h1>hi</h1>');
  } finally {
    await s.close();
  }
});

// ---------------- 安全响应头 ----------------

test('所有响应带 nosniff 与 CSP 头', async () => {
  const s = await startServer({ runner: makeRunner().runner });
  try {
    const res = await fetch(s.base + '/api/health');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    await s.close();
  }
});

test('预览路由的 CSP 放行内联脚本，其它路由不放行', async () => {
  const s = await startServer({ runner: makeRunner().runner });
  try {
    fs.mkdirSync(path.join(s.outRoot, 'd'), { recursive: true });
    fs.writeFileSync(path.join(s.outRoot, 'd', 'a.html'), '<h1>x</h1>');
    const preview = await fetch(s.base + '/preview/d/a.html');
    assert.match(preview.headers.get('content-security-policy'), /script-src 'self' 'unsafe-inline'/);
    await preview.text();

    const api = await fetch(s.base + '/api/health');
    // 只允许 style-src 的内联样式，script-src 不得放行内联脚本
    assert.doesNotMatch(api.headers.get('content-security-policy'), /script-src 'self' 'unsafe-inline'/);
  } finally {
    await s.close();
  }
});

test('GET /api/health 包含契约要求的 browser 字段', async () => {
  const s = await startServer({ runner: makeRunner().runner });
  try {
    const body = await (await fetch(s.base + '/api/health')).json();
    assert.ok('browser' in body, 'health 必须带 browser 字段（无浏览器时为 null）');
    assert.equal(typeof body.ok, 'boolean');
  } finally {
    await s.close();
  }
});

// ---------------- 独立审查发现的问题（回归用例） ----------------

test('取消后不再触发 waitForResume 复活任务，队列不死锁', async () => {
  // 模拟 driver 的真实顺序：先等页面就绪（期间用户点了取消），之后才走到「等待登录」
  let run = 0;
  const runner = async (job, ctx) => {
    run++;
    ctx.emit('navigate', { url: job.urls[0] });
    if (run === 1) {
      await sleep(120);
      await ctx.waitForResume(); // 此时任务已被取消
    }
    return { results: [] };
  };
  const s = await startServer({ runner });
  try {
    const first = await (await postJson(s.base, '/api/jobs', { urls: [VALID_URL] })).json();
    await waitFor(() => s.queue.get(first.id)?.status === 'running');
    await postJson(s.base, `/api/jobs/${first.id}/cancel`, {});

    // 给 runner 走完「取消后才 waitForResume」的路径
    await sleep(300);
    assert.equal(s.queue.get(first.id).status, 'cancelled', '取消的任务不得被 waitForResume 改写状态');
    assert.equal(s.queue.get(first.id)._resume, null);
    assert.equal(s.queue.resumeLogin(first.id), false, '终态任务不可被唤醒');

    // 队列必须还能继续工作
    const second = await (await postJson(s.base, '/api/jobs', { urls: [VALID_URL] })).json();
    assert.ok(await waitFor(() => s.queue.get(second.id)?.status === 'done', { timeout: 3000 }), '取消后队列不能死锁');
  } finally {
    await s.close();
  }
});

test('取消时 SSE 只推一次 job:done', async () => {
  const { runner } = makeRunner({ delay: 100 });
  const s = await startServer({ runner });
  const ac = new AbortController();
  try {
    const res = await fetch(s.base + '/api/events', { signal: ac.signal });
    const seen = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = /^event: (\S+)/m.exec(raw);
            if (ev) seen.push(ev[1]);
          }
        }
      } catch { /* abort */ }
    })();

    const { id } = await (await postJson(s.base, '/api/jobs', { urls: [VALID_URL] })).json();
    await waitFor(() => s.queue.get(id)?.status === 'running');
    await postJson(s.base, `/api/jobs/${id}/cancel`, {});
    await waitFor(() => seen.includes('job:done'), { timeout: 2000 });
    await sleep(200); // 再等一会儿，让重复推送有机会出现
    ac.abort();
    await pump;

    const doneCount = seen.filter(e => e === 'job:done').length;
    assert.equal(doneCount, 1, `job:done 应只推一次，实际 ${doneCount} 次`);
  } finally {
    ac.abort();
    await s.close();
  }
});

test('runner 同步抛错不会打崩进程，任务落 error 且队列继续', async () => {
  const { JobQueue } = await import('../lib/jobs.mjs');
  const queue = new JobQueue({ runner: () => { throw new Error('boom-sync'); } });
  const a = queue.create([VALID_URL]);
  assert.ok(await waitFor(() => a.status === 'error', { timeout: 2000 }), '同步抛错应落 error 而非崩进程');
  assert.equal(a.error.message, 'boom-sync');

  // 队列仍可继续派发
  queue.runner = async () => ({ results: [] });
  const b = queue.create([VALID_URL]);
  assert.ok(await waitFor(() => b.status === 'done', { timeout: 2000 }), '同步抛错后队列必须继续工作');
});

test('assets 事件使用契约字段 done（而非 accumulated）', async () => {
  const { JobQueue } = await import('../lib/jobs.mjs');
  let captured = null;
  const queue = new JobQueue({
    runner: async (job, ctx) => {
      ctx.emit('assets', { chunk: 0, totalChunks: 2, done: 3, assetTotal: 5 });
      captured = job.progress;
      return { results: [] };
    }
  });
  const job = queue.create([VALID_URL]);
  await waitFor(() => job.status === 'done', { timeout: 2000 });
  assert.deepEqual(captured, { chunk: 0, totalChunks: 2, done: 3, assetTotal: 5 });
});
