/**
 * 导出编排层 —— CLI（feishu-export.mjs）与本地服务（server.mjs）共用同一份实现。
 *
 * 设计约束：
 * 1. 本文件不 import 任何第三方包；
 * 2. 本文件**不写 stdout / 不读 stdin**，进度一律通过 onEvent 回调外抛，
 *    由调用方决定「打印成人话」还是「推成 SSE 事件」；
 * 3. 事件形状是稳定契约（见 计划书 §2.3），改动需同步 GUI 与 CLI 两侧。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, sleep } from './cdp.mjs';
import { captureDoc } from './capture.mjs';
import { render, writeAssets } from './render.mjs';

/** 项目根目录（lib/ 的上一级），等价于原 CLI 里的 __dirname */
export const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];
const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];

/** 每批拉取的资源数，避免单条 CDP 消息过大 */
const ASSET_CHUNK = 8;

/** 用户主动取消（而非失败），调用方据此区分状态 */
export class CancelledError extends Error {
  constructor(message = '导出已取消') {
    super(message);
    this.name = 'CancelledError';
    this.code = 'CANCELLED';
  }
}

/** 带错误码的业务异常，供 GUI 显示可行动原因 */
export class ExportError extends Error {
  constructor(message, code = 'UNKNOWN') {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

export function findBrowser(name) {
  const list = name === 'edge' ? EDGE_CANDIDATES : name === 'chrome' ? CHROME_CANDIDATES : [...CHROME_CANDIDATES, ...EDGE_CANDIDATES];
  for (const p of list) if (fs.existsSync(p)) return p;
  throw new ExportError('未找到 Chrome/Edge，请用 --browser 指定或安装浏览器', 'NO_BROWSER');
}

export async function isPortOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch { return false; }
}

/**
 * 确保有一个开着调试端口的浏览器可用；端口已开则直接复用。
 * @returns {{launched:boolean, exe?:string, profile?:string}}
 */
export async function ensureBrowser(opts) {
  if (await isPortOpen(opts.port)) {
    return { launched: false };
  }
  const exe = findBrowser(opts.browser);
  const profile = opts.profile || path.join(PROJECT_ROOT, '.browser-profile');
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--window-size=1440,900',
    'about:blank'
  ];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    if (await isPortOpen(opts.port)) return { launched: true, exe, profile };
  }
  throw new ExportError(`浏览器已启动但 CDP 端口 ${opts.port} 未就绪`, 'CDP_TIMEOUT');
}

export const docIdOf = url => {
  const m = /\/docx\/([A-Za-z0-9]+)/.exec(url) || /\/docs\/([A-Za-z0-9]+)/.exec(url) || /\/wiki\/([A-Za-z0-9]+)/.exec(url);
  if (!m) throw new ExportError(`无法从链接中解析文档 ID：${url}`, 'BAD_URL');
  return m[1];
};

/**
 * 生成安全目录名。
 * 原实现 `safeName('..')` 会返回 `..`，导致 `path.join(out, '..')` 把产物写到 out/ 之外（P2-5）。
 */
export const safeName = (s, fallback = 'untitled') => {
  const cleaned = String(s || '')
    .replace(/[\\/:*?"<>|\n\r\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '') // 纯点号（. / .. / ...）不能当目录名
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
};

/** 校验最终输出目录确实落在 outRoot 之内，越界即拒绝（配合 safeName，双层防护） */
export function assertInsideOut(outRoot, outDir) {
  const root = path.resolve(outRoot);
  const target = path.resolve(outDir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new ExportError(`输出路径越界：${target} 不在 ${root} 之内`, 'BAD_PATH');
  }
  return target;
}

const assertNotAborted = signal => {
  if (signal?.aborted) throw new CancelledError();
};

/**
 * 等页面真正可用：readyState=complete + 已在 https 页面 + 正文有内容。
 *
 * 为什么不用 `waitForReady + sleep(2500)` 死等：导航刚完成的那一小段里，
 * 页面内 fetch 会被中断并抛 `TypeError: Failed to fetch`（实测：同一链接
 * 死等 2.5s 偶发失败，等页面就绪后 100% 成功）。死等是时序赌博。
 */
export async function waitForDocReady(cdp, sessionId, timeoutMs = 45_000, signal) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw new CancelledError(); // 取消要能打断等待，否则队列被占满 45s
    try {
      const s = await evaluate(cdp, sessionId, `({
        ready: document.readyState,
        https: location.protocol === 'https:',
        bodyLen: ((document.body && document.body.innerText) || '').length
      })`);
      if (s && s.ready === 'complete' && s.https && s.bodyLen > 0) {
        await sleep(1200); // 稳定期：给飞书前端把登录态/文档上下文准备好
        return true;
      }
    } catch { /* 导航过程中 evaluate 本身可能失败，继续轮询 */ }
    await sleep(500);
  }
  return false;
}

/**
 * 导出单个飞书文档到 opts.out/<标题>/。
 *
 * @param {import('./cdp.mjs').CDP} cdp
 * @param {string} sessionId
 * @param {string} url
 * @param {{out:string, md?:boolean, waitLogin?:boolean, promptLogin?:()=>Promise<void>, signal?:AbortSignal}} opts
 * @param {(e:object)=>void} onEvent 进度事件回调（形状见 计划书 §2.3）
 * @returns {Promise<{outDir:string, htmlPath:string, mdPath:string|null, manifest:object}>}
 */
export async function exportOne(cdp, sessionId, url, opts, onEvent = () => {}) {
  const emit = e => onEvent({ at: Date.now(), ...e });
  const signal = opts.signal;

  assertNotAborted(signal);
  const docId = docIdOf(url);
  emit({ phase: 'navigate', url });
  await cdp.send('Page.navigate', { url }, sessionId);
  const pageReady = await waitForDocReady(cdp, sessionId, 45_000, signal);
  if (!pageReady) {
    // 不在此处直接失败：登录墙页面也算"有内容"，交给 probe 给出可行动错误码
    emit({ phase: 'slow_page' });
  }

  assertNotAborted(signal);
  if (opts.waitLogin) {
    if (typeof opts.promptLogin !== 'function') {
      throw new ExportError('waitLogin 需要提供 promptLogin 回调', 'BAD_OPTIONS');
    }
    emit({ phase: 'waiting_login', url });
    await opts.promptLogin();
  }

  // 1) 先拿块清单（不下载资源），确认可读
  //    传 null（探查语义）而不是 []：null 会带回资源清单供 manifest 判定 missing（P1-2）
  assertNotAborted(signal);
  const probe = await evaluate(cdp, sessionId, `(${captureDoc.toString()})(${JSON.stringify(docId)}, null, ${ASSET_CHUNK})`);
  if (!probe.blockCount) {
    throw new ExportError('未取到内容：可能需要登录（加 --wait-login）或文档无权限', 'NO_CONTENT');
  }
  emit({ phase: 'probe', blockCount: probe.blockCount, assetTotal: probe.assetTotal, title: probe.title, totalChunks: probe.totalChunks });

  // 2) 分批拉资源
  const assetData = {};
  const skippedAssets = [];
  const maxAssetBytes = Number.isFinite(opts.maxAssetBytes) && opts.maxAssetBytes > 0 ? opts.maxAssetBytes : null;
  for (let ci = 0; ci < probe.totalChunks; ci++) {
    assertNotAborted(signal);
    const chunk = await evaluate(cdp, sessionId, `(${captureDoc.toString()})(${JSON.stringify(docId)}, [${ci}], ${ASSET_CHUNK}, ${maxAssetBytes === null ? 'null' : maxAssetBytes})`);
    Object.assign(assetData, chunk.assetPayload || {});
    if (Array.isArray(chunk.skippedAssets)) skippedAssets.push(...chunk.skippedAssets);
    emit({
      phase: 'assets',
      chunk: ci,
      totalChunks: probe.totalChunks,
      done: Object.keys(assetData).length,
      assetTotal: probe.assetTotal
    });
  }

  // 3) 取回全量 block 数据（已缓存在页面内）
  assertNotAborted(signal);
  const blocks = await evaluate(cdp, sessionId, `window.__feishuExport.blocks`);
  emit({ phase: 'blocks', blocks: Object.keys(blocks.block_map || {}).length });

  // 4) 落盘 + 渲染
  const title = safeName(probe.title || docId, `untitled-${docId.slice(0, 8)}`);
  const outDir = assertInsideOut(opts.out, path.join(opts.out, title));
  fs.mkdirSync(outDir, { recursive: true });

  const assetMap = writeAssets(outDir, assetData);
  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const { html, md, toc, stats, unsupported, degraded, renderErrors, danglingRefs } = render({
    block_map: blocks.block_map,
    docId,
    assets: assetMap,
    meta: { title: probe.title || docId, sourceUrl: url, exportedAt }
  });
  emit({ phase: 'render', tocEntries: toc.length, renderedBlocks: stats.renderedBlocks });

  const htmlPath = path.join(outDir, `${title}.html`);
  fs.writeFileSync(htmlPath, html);
  let mdPath = null;
  if (opts.md) {
    mdPath = path.join(outDir, `${title}.md`);
    fs.writeFileSync(mdPath, md);
  }

  // ---- 诚实性告警：绝不把"少导了内容"包装成"全部完成"（P0-1） ----
  const skippedTokenSet = new Set(skippedAssets.map(s => s.token));
  // 缺 = 既没落盘、也不是被体积上限主动跳过（后者必须单独归类，否则会被误报成"资源缺失"）
  const missingTokens = (probe.assets || [])
    .filter(a => !assetMap[a.token] && !skippedTokenSet.has(a.token))
    .map(a => a.token);
  const unsupportedTypeCounts = unsupported.reduce((acc, u) => {
    acc[u.type] = (acc[u.type] || 0) + 1;
    return acc;
  }, {});
  const maxBytesMb = Math.round((maxAssetBytes || 128 * 1024 * 1024) / (1024 * 1024));
  const warnings = [];
  if (probe.truncated) {
    warnings.push(`文档过大，分页在第 ${probe.pagesFetched} 页被截断，后续内容未导出`);
  }
  if (unsupported.length) {
    const detail = Object.entries(unsupportedTypeCounts).map(([t, n]) => `${t}×${n}`).join('、');
    warnings.push(`未支持块 ${unsupported.length} 个（${detail}），已在正文中以占位标注，内容未导出`);
  }
  if (renderErrors.length) warnings.push(`渲染失败块 ${renderErrors.length} 个，已在正文中以占位标注`);
  if (degraded.length) warnings.push(`降级渲染块 ${degraded.length} 个（内容保留，语义可能丢失）`);
  if (danglingRefs.length) warnings.push(`${danglingRefs.length} 个块引用的子块未取到（block_map 不完整），对应内容无法渲染`);
  if (skippedAssets.length) {
    const mb = skippedAssets.map(s => Math.round((s.size || 0) / (1024 * 1024))).join('MB/') + 'MB';
    warnings.push(`超大资源跳过 ${skippedAssets.length} 个（${mb}，超过 ${maxBytesMb}MB 上限；需要时用 --max-asset-bytes 放开）`);
  }
  if (missingTokens.length) warnings.push(`资源缺失 ${missingTokens.length} 个`);

  const manifest = {
    sourceUrl: url,
    docId,
    title: probe.title,
    exportedAt,
    isoTime: new Date().toISOString(),
    browser: cdp.browserVersion,
    // blockCount 是输入块总数，renderedBlocks 才反映真正渲染出内容的块数。
    // 两者并列写出，杜绝用单一"块数"暗示内容完整（P0-1）。
    blockCount: probe.blockCount,
    renderedBlocks: stats.renderedBlocks,
    unsupportedTypes: unsupportedTypeCounts,
    unsupported: unsupported.slice(0, 200),
    degradedCount: degraded.length,
    renderErrors: renderErrors.slice(0, 50),
    danglingRefs: danglingRefs.slice(0, 50),
    truncated: probe.truncated === true,
    pagesFetched: probe.pagesFetched ?? null,
    rootChildren: probe.rootChildren,
    tocEntries: toc.length,
    assets: {
      total: probe.assetTotal,
      saved: Object.keys(assetMap).length,
      missing: missingTokens,
      skipped: skippedAssets
    },
    warnings,
    outputs: { html: path.basename(htmlPath), md: mdPath ? path.basename(mdPath) : null },
    stats
  };
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  emit({ phase: 'write', outDir, manifestPath });
  if (warnings.length) emit({ phase: 'warnings', items: warnings });

  emit({
    phase: 'done',
    outDir,
    htmlPath,
    mdPath,
    manifest,
    // 下面三个是给 CLI 还原日志行用的展示字段，GUI 可忽略
    htmlKB: (fs.statSync(htmlPath).size / 1024).toFixed(0),
    tocEntries: toc.length,
    savedAssets: Object.keys(assetMap).length,
    assetTotal: probe.assetTotal
  });

  return { outDir, htmlPath, mdPath, manifest };
}
