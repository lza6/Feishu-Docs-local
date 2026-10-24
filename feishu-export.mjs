#!/usr/bin/env node
/**
 * 飞书文档一键导出（离线版）
 * 零第三方依赖：用 CDP 驱动本机 Chrome/Edge，调用飞书自身接口抓取全量块数据。
 *
 * 用法：
 *   node feishu-export.mjs <飞书链接> [更多链接...] [选项]
 * 选项：
 *   --out <目录>       输出根目录（默认 ./out）
 *   --port <端口>      CDP 调试端口（默认 9222）
 *   --browser <name>   chrome | edge（默认自动探测）
 *   --profile <目录>   浏览器用户目录（默认本工具下 .browser-profile，登录态可复用）
 *   --wait-login       打开页面后等待回车再抓取（文档需要登录时用）
 *   --no-md            不生成 Markdown
 *   --keep-open        结束后不关闭浏览器
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { CDP, evaluate, waitForReady, sleep } from './lib/cdp.mjs';
import { captureDoc } from './lib/capture.mjs';
import { render, writeAssets } from './lib/render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function parseArgs(argv) {
  const opts = { urls: [], out: 'out', port: 9222, browser: null, profile: null, waitLogin: false, md: true, keepOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--browser') opts.browser = argv[++i];
    else if (a === '--profile') opts.profile = argv[++i];
    else if (a === '--wait-login') opts.waitLogin = true;
    else if (a === '--no-md') opts.md = false;
    else if (a === '--keep-open') opts.keepOpen = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (!a.startsWith('--')) opts.urls.push(a);
  }
  return opts;
}

function printHelp() {
  console.log(`
飞书文档一键导出（离线版）
  node feishu-export.mjs <飞书文档链接> [--out 目录] [--wait-login]

示例：
  node feishu-export.mjs "https://xxx.feishu.cn/docx/AbCdEf123" --out ./out
  node feishu-export.mjs "https://xxx.feishu.cn/docx/AbCdEf123" --wait-login   # 需登录的文档

输出：
  <out>/<文档标题>/<文档标题>.html   离线阅读（含侧边目录、图片本地化）
  <out>/<文档标题>/<文档标题>.md     Markdown
  <out>/<文档标题>/assets/           图片/白板/附件
  <out>/<文档标题>/manifest.json     抓取元数据（证据用）
`);
}

function findBrowser(name) {
  const list = name === 'edge' ? EDGE_CANDIDATES : name === 'chrome' ? CHROME_CANDIDATES : [...CHROME_CANDIDATES, ...EDGE_CANDIDATES];
  for (const p of list) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge，请用 --browser 指定或安装浏览器');
}

async function isPortOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch { return false; }
}

async function ensureBrowser(opts) {
  if (await isPortOpen(opts.port)) {
    return { launched: false };
  }
  const exe = findBrowser(opts.browser);
  const profile = opts.profile || path.join(__dirname, '.browser-profile');
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
  throw new Error(`浏览器已启动但 CDP 端口 ${opts.port} 未就绪`);
}

const docIdOf = url => {
  const m = /\/docx\/([A-Za-z0-9]+)/.exec(url) || /\/docs\/([A-Za-z0-9]+)/.exec(url) || /\/wiki\/([A-Za-z0-9]+)/.exec(url);
  if (!m) throw new Error(`无法从链接中解析文档 ID：${url}`);
  return m[1];
};

const safeName = s => String(s || 'untitled').replace(/[\\/:*?"<>|\n\r\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);

async function exportOne(cdp, sessionId, url, opts, log) {
  const docId = docIdOf(url);
  log(`打开文档：${url}`);
  await cdp.send('Page.navigate', { url }, sessionId);
  await waitForReady(cdp, sessionId);
  await sleep(2500); // 等前端把登录态/文档上下文准备好

  if (opts.waitLogin) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('如页面提示登录，请在浏览器里登录并等文档正文显示出来，然后按回车继续…');
    rl.close();
  }

  // 1) 先拿块清单（不下载资源），确认可读
  const probe = await evaluate(cdp, sessionId, `(${captureDoc.toString()})(${JSON.stringify(docId)}, [], 8)`);
  if (!probe.blockCount) throw new Error('未取到内容：可能需要登录（加 --wait-login）或文档无权限');
  log(`内容块：${probe.blockCount}，资源：${probe.assetTotal}，标题：${probe.title}`);

  // 2) 分批拉资源
  const assetData = {};
  for (let ci = 0; ci < probe.totalChunks; ci++) {
    const chunk = await evaluate(cdp, sessionId, `(${captureDoc.toString()})(${JSON.stringify(docId)}, [${ci}], 8)`);
    Object.assign(assetData, chunk.assetPayload || {});
    log(`  资源批次 ${ci + 1}/${probe.totalChunks} 完成（累计 ${Object.keys(assetData).length}/${probe.assetTotal}）`);
  }

  // 3) 取回全量 block 数据（已缓存在页面内）
  const blocks = await evaluate(cdp, sessionId, `window.__feishuExport.blocks`);

  // 4) 落盘 + 渲染
  const title = safeName(probe.title || docId);
  const outDir = path.join(opts.out, title);
  fs.mkdirSync(outDir, { recursive: true });

  const assetMap = writeAssets(outDir, assetData);
  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const { html, md, toc, stats } = render({
    block_map: blocks.block_map,
    docId,
    assets: assetMap,
    meta: { title: probe.title || docId, sourceUrl: url, exportedAt }
  });

  const htmlPath = path.join(outDir, `${title}.html`);
  fs.writeFileSync(htmlPath, html);
  let mdPath = null;
  if (opts.md) {
    mdPath = path.join(outDir, `${title}.md`);
    fs.writeFileSync(mdPath, md);
  }

  const manifest = {
    sourceUrl: url,
    docId,
    title: probe.title,
    exportedAt,
    isoTime: new Date().toISOString(),
    browser: cdp.browserVersion,
    blockCount: probe.blockCount,
    rootChildren: probe.rootChildren,
    tocEntries: toc.length,
    assets: {
      total: probe.assetTotal,
      saved: Object.keys(assetMap).length,
      missing: probe.assets ? probe.assets.filter(a => !assetMap[a.token]).map(a => a.token) : []
    },
    outputs: { html: path.basename(htmlPath), md: mdPath ? path.basename(mdPath) : null },
    stats
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  log(`完成：${outDir}`);
  log(`  HTML ${(fs.statSync(htmlPath).size / 1024).toFixed(0)} KB · 目录 ${toc.length} 条 · 资源 ${Object.keys(assetMap).length}/${probe.assetTotal}`);
  return { outDir, htmlPath, mdPath, manifest };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.urls.length) { printHelp(); process.exit(1); }
  const log = msg => console.log(msg);

  const info = await ensureBrowser(opts);
  log(info.launched ? `已启动浏览器：${path.basename(info.exe)}（profile: ${info.profile}）` : `复用已开启的调试端口 ${opts.port}`);

  const cdp = await CDP.connect(opts.port);
  log(`CDP 已连接：${cdp.browserVersion}`);

  const results = [];
  try {
    for (const url of opts.urls) {
      const { targetId, sessionId } = await cdp.newPage('about:blank');
      try {
        results.push(await exportOne(cdp, sessionId, url, opts, log));
      } finally {
        await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      }
    }
  } finally {
    await cdp.close();
  }

  log('\n全部完成：');
  for (const r of results) log(`  ${r.outDir}`);
  if (!opts.keepOpen && info.launched) log('\n提示：浏览器可手动关闭（登录态已保存在 profile 里，下次免登录）。');
}

main().catch(err => {
  console.error(`\n导出失败：${err.message}`);
  if (/登录|login|权限|403|401/.test(err.message)) {
    console.error('建议：加 --wait-login 参数，在打开的浏览器里登录后回车再抓取。');
  }
  process.exit(1);
});
