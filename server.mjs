#!/usr/bin/env node
/**
 * 本地 Web 工作台服务 —— 零依赖（只用 node:http），SSE 推进度。
 *
 * 安全模型前提：**只监听 127.0.0.1**。这是单机工具的边界，不做任何远程暴露；
 * 因此不实现鉴权，改为校验 Host / Origin（防 DNS rebinding 与跨站请求）。
 *
 * 用法：
 *   node server.mjs [--port 7801] [--out ./out] [--allow-any-host]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { CDP } from './lib/cdp.mjs';
import { ensureBrowser, exportOne, PROJECT_ROOT } from './lib/driver.mjs';
import { JobQueue, toPublic } from './lib/jobs.mjs';

const DEFAULT_PORT = 7801;
const BODY_LIMIT = 256 * 1024;
const MAX_URLS = 50;
const SSE_HEARTBEAT_MS = 15_000;

/** 默认只接受飞书租户域名，避免把本机变成任意站点的导出跳板 */
const FEISHU_URL_RE = /^https:\/\/([a-z0-9-]+\.)*(feishu\.cn|larksuite\.com)\//i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2'
};

// ---------------- 基础工具 ----------------

function setSecurityHeaders(res, { inlineScript = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    // 导出的离线 HTML 靠一段内联脚本做目录滚动高亮；预览它时必须放行内联脚本，
    // 否则「离线阅读」在经服务预览时交互静默失效（直接双击本地文件打开则正常）。
    inlineScript ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "frame-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'"
  ].join('; '));
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** Host 头必须是本机回环地址且端口与服务一致 —— 防 DNS rebinding */
function hostAllowed(req, getPort) {
  const host = String(req.headers.host || '').trim();
  const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/i.exec(host);
  if (!m) return false;
  return Number(m[2]) === getPort();
}

/** 浏览器跨站请求会带 Origin；非浏览器（curl / 地址栏导航）不带，直接放行 */
function originAllowed(req, getPort) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const p = getPort();
  return [`http://127.0.0.1:${p}`, `http://localhost:${p}`, `http://[::1]:${p}`].includes(String(origin).toLowerCase());
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    let settled = false;
    const chunks = [];
    const done = fn => { if (!settled) { settled = true; fn(); } };
    // 超限后不立刻 destroy：把剩余数据排空（不入内存）以便还能正常回 413
    req.on('data', c => {
      size += c.length;
      if (size > limit) { over = true; return; }
      chunks.push(c);
    });
    req.on('end', () => done(() => {
      if (over) reject(Object.assign(new Error('请求体超过 256KB 上限'), { status: 413 }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    }));
    req.on('error', err => done(() => reject(err)));
    // 客户端中途断开时某些 Node 版本只发 'close' 不发 'error'，
    // 不处理会让 await readJson() 永久悬挂
    req.on('close', () => done(() => reject(Object.assign(new Error('客户端提前断开连接'), { status: 400 }))));
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

/** 在 root 内安全解析相对路径：先 resolve 再 realpath，双重越界校验 */
function resolveInside(root, relPath) {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, relPath);
  if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) return null;
  let realRoot;
  let realTarget;
  try {
    realRoot = fs.realpathSync(rootAbs);
    realTarget = fs.realpathSync(target);
  } catch {
    return null;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
  return realTarget;
}

function newestMtime(dir) {
  let newest = 0;
  const walk = d => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try { newest = Math.max(newest, fs.statSync(full).mtimeMs); } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return newest;
}

// ---------------- 真实执行器（driver） ----------------

/** 探测浏览器是否就绪并取版本号（health 用） */
async function cdpInfo(port = 9222) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { up: false, browser: null };
    const v = await res.json();
    return { up: true, browser: v.Browser ?? null };
  } catch {
    return { up: false, browser: null };
  }
}

function driverRunner(outRoot) {
  return async (job, ctx) => {
    const port = job.opts.port || 9222;
    const info = await ensureBrowser({ port, browser: job.opts.browser || null, profile: job.opts.profile || null });
    ctx.emit('launch', {
      browser: info.exe ? path.basename(info.exe) : null,
      profile: info.profile ?? null,
      reused: !info.launched
    });

    const cdp = await CDP.connect(port);
    ctx.emit('cdp', { version: cdp.browserVersion });

    const results = [];
    try {
      for (const url of job.urls) {
        ctx.emit('job_url', { url });
        const { targetId, sessionId } = await cdp.newPage('about:blank');
        try {
          const r = await exportOne(cdp, sessionId, url, {
            out: outRoot,
            md: job.opts.md !== false,
            waitLogin: !!job.opts.waitLogin,
            promptLogin: () => ctx.waitForResume(),
            signal: ctx.signal
          }, e => {
            const { phase, at, ...rest } = e;
            ctx.emit(phase, rest);
          });
          results.push({ outDir: r.outDir, htmlPath: r.htmlPath, mdPath: r.mdPath, manifest: r.manifest });
        } finally {
          await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
        }
      }
    } finally {
      await cdp.close();
    }
    return { results };
  };
}

// ---------------- 应用 ----------------

/**
 * @param {{outRoot?:string, allowAnyHost?:boolean, runner?:Function, uiDir?:string}} cfg
 * @returns {{server: http.Server, queue: JobQueue}}
 */
export function createApp(cfg = {}) {
  const outRoot = path.resolve(cfg.outRoot || 'out');
  const uiDir = path.resolve(cfg.uiDir || path.join(PROJECT_ROOT, 'ui', 'dist'));
  const allowAnyHost = !!cfg.allowAnyHost;

  const queue = new JobQueue({ runner: cfg.runner || driverRunner(outRoot) });
  const sseClients = new Set();

  const currentPort = () => server.address()?.port ?? 0;

  const uiStatus = () => {
    const indexPath = path.join(uiDir, 'index.html');
    if (!fs.existsSync(indexPath)) return { built: false, builtAt: null, stale: true };
    const builtAt = fs.statSync(indexPath).mtimeMs;
    const srcNewest = newestMtime(path.join(PROJECT_ROOT, 'ui', 'src'));
    return { built: true, builtAt, stale: srcNewest > builtAt };
  };

  const broadcast = job => {
    const payload = toPublic(job);
    for (const client of sseClients) {
      try {
        client.write(`event: job:update\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
    // job:done 只推一次：队列的 .finally 也会 emit，重复推送会让 UI 重复刷新
    if (!job._donePushed && (job.status === 'done' || job.status === 'error' || job.status === 'cancelled')) {
      job._donePushed = true;
      for (const client of sseClients) {
        try { client.write(`event: job:done\ndata: ${JSON.stringify({ id: job.id, status: job.status })}\n\n`); } catch { /* ignore */ }
      }
    }
  };
  queue.on('job', broadcast);

  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res);

    if (!hostAllowed(req, currentPort)) {
      return sendJson(res, 403, { error: 'Host 不被允许：仅接受 127.0.0.1 / localhost' });
    }
    if (!originAllowed(req, currentPort)) {
      return sendJson(res, 403, { error: 'Origin 不被允许：仅接受本机来源' });
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      return sendJson(res, 400, { error: '路径编码非法' });
    }

    try {
      // ---- 健康检查 ----
      if (req.method === 'GET' && pathname === '/api/health') {
        const cdp = await cdpInfo(9222);
        return sendJson(res, 200, {
          ok: true,
          port: currentPort(),
          cdp: cdp.up,
          browser: cdp.browser,
          ui: uiStatus(),
          allowAnyHost
        });
      }

      // ---- SSE ----
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive'
        });
        res.write('event: hello\ndata: {"ok":true}\n\n');
        sseClients.add(res);
        const timer = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { /* ignore */ }
        }, SSE_HEARTBEAT_MS);
        req.on('close', () => {
          clearInterval(timer);
          sseClients.delete(res);
        });
        return;
      }

      // ---- 任务 ----
      if (pathname === '/api/jobs' && req.method === 'GET') {
        return sendJson(res, 200, { jobs: queue.list().map(toPublic) });
      }

      if (pathname === '/api/jobs' && req.method === 'POST') {
        const body = await readJson(req);
        const urls = body?.urls;
        if (!Array.isArray(urls) || urls.length === 0) {
          return sendJson(res, 400, { error: 'urls 必须是非空数组' });
        }
        if (urls.length > MAX_URLS) {
          return sendJson(res, 400, { error: `一次最多 ${MAX_URLS} 个链接` });
        }
        for (const u of urls) {
          if (typeof u !== 'string') return sendJson(res, 400, { error: 'urls 元素必须是字符串' });
          let parsedUrl;
          try { parsedUrl = new URL(u); } catch { return sendJson(res, 400, { error: `不是合法 URL：${u}` }); }
          if (parsedUrl.protocol !== 'https:') return sendJson(res, 400, { error: `必须使用 https：${u}` });
          if (!allowAnyHost && !FEISHU_URL_RE.test(u)) {
            return sendJson(res, 400, { error: `只接受飞书域名（feishu.cn / larksuite.com）：${u}` });
          }
          if (!/\/(docx|docs|wiki)\/[A-Za-z0-9]+/.test(parsedUrl.pathname)) {
            return sendJson(res, 400, { error: `不是可导出的文档链接（需 /docx/ /docs/ /wiki/）：${u}` });
          }
        }
        const job = queue.create(urls, {
          out: outRoot,
          md: body?.opts?.md !== false,
          waitLogin: body?.opts?.waitLogin === true
        });
        return sendJson(res, 201, { id: job.id, status: job.status });
      }

      const jobMatch = /^\/api\/jobs\/([\w-]+)(\/cancel|\/resume-login)?$/.exec(pathname);
      if (jobMatch) {
        const [, id, action] = jobMatch;
        const job = queue.get(id);
        if (!job) return sendJson(res, 404, { error: '任务不存在' });
        if (!action && req.method === 'GET') return sendJson(res, 200, toPublic(job));
        if (action === '/cancel' && req.method === 'POST') {
          const ok = queue.cancel(id);
          return sendJson(res, ok ? 202 : 409, { id, cancelled: ok, status: job.status });
        }
        if (action === '/resume-login' && req.method === 'POST') {
          const ok = queue.resumeLogin(id);
          return sendJson(res, ok ? 202 : 409, { id, resumed: ok, status: job.status });
        }
        return sendJson(res, 405, { error: '方法不被允许' });
      }

      // ---- 产物预览（只读 out/ 以内） ----
      if (req.method === 'GET' && pathname.startsWith('/preview/')) {
        const rel = pathname.slice('/preview/'.length);
        const abs = resolveInside(outRoot, rel);
        if (!abs) return sendJson(res, 404, { error: '产物不存在或路径越界' });
        // 预览的是本工具自己生成的离线 HTML，它依赖一段内联脚本做目录高亮
        setSecurityHeaders(res, { inlineScript: true });
        return serveFile(res, abs);
      }

      // ---- 前端静态资源（ui/dist） ----
      if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/assets/'))) {
        const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
        const abs = resolveInside(uiDir, rel);
        if (!abs) {
          if (pathname === '/') {
            return sendText(res, 503, '前端尚未构建。请先执行：npm --prefix ui install && npm --prefix ui run build\n');
          }
          return sendJson(res, 404, { error: '资源不存在' });
        }
        return serveFile(res, abs);
      }

      // SPA 回退：非 API 的非文件路径交给前端路由
      if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        const abs = resolveInside(uiDir, 'index.html');
        if (abs) return serveFile(res, abs);
      }

      return sendJson(res, 404, { error: `未找到路由：${req.method} ${pathname}` });
    } catch (err) {
      const status = err?.status || 500;
      if (status >= 500) console.error('[server]', err);
      // 响应头已发出时不能再写 JSON，否则二次抛错会变成 unhandledRejection
      if (res.headersSent) {
        try { res.end(); } catch { /* 连接已断 */ }
        return;
      }
      return sendJson(res, status, { error: err?.message || '服务器内部错误' });
    }
  });

  server.on('close', () => {
    for (const client of sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
  });

  return { server, queue };
}

function serveFile(res, absPath) {
  let stat;
  try { stat = fs.statSync(absPath); } catch { return sendJson(res, 404, { error: '文件不存在' }); }
  if (!stat.isFile()) return sendJson(res, 404, { error: '不是文件' });
  const type = MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
  // 必须用 pipeline 而不是 .pipe()：statSync 与 open 之间是 TOCTOU 窗口，
  // 源流的 'error' 若无人监听会变成 uncaughtException 直接打崩服务进程；
  // pipeline 还会在任一端出错/中断时销毁另一侧，避免文件句柄泄漏。
  pipeline(fs.createReadStream(absPath), res, err => {
    if (err && !res.headersSent) {
      try { sendJson(res, 500, { error: '读取文件失败' }); } catch { /* 连接已断 */ }
    }
  });
}

// ---------------- CLI 入口 ----------------

function parseArgv(argv) {
  const opts = { port: DEFAULT_PORT, out: 'out', allowAnyHost: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--allow-any-host') opts.allowAnyHost = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return opts;
}

function printHelp() {
  console.log(`
飞书导出 · 本地 Web 工作台
  node server.mjs [--port 7801] [--out ./out] [--allow-any-host]

  --port <端口>        监听端口（只绑 127.0.0.1，默认 7801）
  --out <目录>         产物根目录（默认 ./out）
  --allow-any-host     放开 URL 域名白名单（默认只允许飞书域名；开放即扩大 SSRF 面，慎用）

启动后浏览器打开 http://127.0.0.1:<端口>/
`);
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const { server } = createApp({ outRoot: args.out, allowAnyHost: args.allowAnyHost });
  server.listen(args.port, '127.0.0.1', () => {
    const { port } = server.address();
    console.log(`工作台已启动：http://127.0.0.1:${port}/`);
    console.log(`产物目录：${path.resolve(args.out)}`);
    console.log(`域名白名单：${args.allowAnyHost ? '已放开（--allow-any-host）' : '仅 feishu.cn / larksuite.com'}`);
    console.log('按 Ctrl+C 退出');
  });
  const shutdown = () => { server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('服务启动失败：', err.message);
    process.exit(1);
  });
}
