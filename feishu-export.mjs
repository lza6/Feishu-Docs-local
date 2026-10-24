#!/usr/bin/env node
/**
 * 飞书文档一键导出（离线版）—— CLI 入口。
 *
 * 真正的编排逻辑在 lib/driver.mjs（与本地服务工作台共用同一份实现）；
 * 本文件只负责三件事：解析命令行参数、把结构化进度事件翻译成人话、打印结果。
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
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { CDP } from './lib/cdp.mjs';
import { ensureBrowser, exportOne, CancelledError, ExportError } from './lib/driver.mjs';

function fail(msg) {
  console.error(`参数错误：${msg}`);
  console.error('用 --help 查看用法。');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { urls: [], out: 'out', port: 9222, browser: null, profile: null, waitLogin: false, md: true, keepOpen: false, maxAssetBytes: null };
  // 统一取值校验：原来 `--out` 缺值会让 path 模块抛裸 TypeError，`--port abc` 会变成 NaN（P2-8）
  const need = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${flag} 需要一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { opts.out = need(i, '--out'); i++; }
    else if (a === '--port') {
      const raw = need(i, '--port');
      i++;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`--port 需要 1-65535 的整数，收到 "${raw}"`);
      opts.port = n;
    }
    else if (a === '--browser') {
      const v = need(i, '--browser');
      i++;
      if (!['chrome', 'edge'].includes(v)) fail(`--browser 只能是 chrome 或 edge，收到 "${v}"`);
      opts.browser = v;
    }
    else if (a === '--profile') { opts.profile = need(i, '--profile'); i++; }
    else if (a === '--max-asset-bytes') {
      const raw = need(i, '--max-asset-bytes');
      i++;
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) fail(`--max-asset-bytes 需要正整数（字节数），收到 "${raw}"`);
      opts.maxAssetBytes = n;
    }
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

选项：
  --out <目录>           输出根目录（默认 ./out）
  --port <端口>          CDP 调试端口（默认 9222，已开则复用）
  --browser <name>       chrome | edge（默认自动探测）
  --profile <目录>       浏览器用户目录（默认 ./.browser-profile，登录态可复用）
  --wait-login           打开页面后等待回车再抓取（文档需要登录时用）
  --no-md                不生成 Markdown
  --keep-open            结束后不提示关闭浏览器
  --max-asset-bytes <n>  单个资源体积上限（字节，默认 134217728 = 128MB）；超限跳过并在告警中列出

输出：
  <out>/<文档标题>/<文档标题>.html   离线阅读（含侧边目录、图片本地化）
  <out>/<文档标题>/<文档标题>.md     Markdown
  <out>/<文档标题>/assets/           图片/白板/附件
  <out>/<文档标题>/manifest.json     抓取元数据（证据用）
`);
}

/**
 * 把 driver 抛出的结构化事件翻译成 CLI 的人类可读日志行。
 * 这些文本是 CLI 的对外契约，改动会破坏用户已有脚本/习惯，需谨慎。
 */
function eventToLogLines(e) {
  switch (e.phase) {
    case 'navigate':
      return [`打开文档：${e.url}`];
    case 'probe':
      return [`内容块：${e.blockCount}，资源：${e.assetTotal}，标题：${e.title}`];
    case 'assets':
      return [`  资源批次 ${e.chunk + 1}/${e.totalChunks} 完成（累计 ${e.done}/${e.assetTotal}）`];
    case 'render':
      return [];
    case 'warnings':
      // 只在"少导了内容"时出现，普通文档不打印，保持既有输出兼容
      return e.items.map(w => `  ⚠ ${w}`);
    case 'done':
      return [
        `完成：${e.outDir}`,
        `  HTML ${e.htmlKB} KB · 目录 ${e.tocEntries} 条 · 资源 ${e.savedAssets}/${e.assetTotal}`
      ];
    default:
      return []; // waiting_login / blocks / render / write 在 CLI 下不单独打印
  }
}

async function promptLogin() {
  // 非 TTY（CI、管道、重定向 stdin）下 readline 会永久挂起，必须提前报错而不是卡住（P2-7）
  if (!process.stdin.isTTY) {
    throw new ExportError(
      '--wait-login 需要交互终端，但当前 stdin 不是 TTY（可能运行在 CI 或管道中）。'
      + '请在本机终端运行，或先用 --profile 指向一个已登录的浏览器用户目录。',
      'NOT_TTY'
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('如页面提示登录，请在浏览器里登录并等文档正文显示出来，然后按回车继续…');
  rl.close();
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
        results.push(await exportOne(cdp, sessionId, url, { ...opts, promptLogin }, e => {
          for (const line of eventToLogLines(e)) log(line);
        }));
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
  if (err instanceof CancelledError) process.exit(130);
  // NOT_TTY 说明用户已经加了 --wait-login，再建议"加 --wait-login"只会误导
  if (err.code !== 'NOT_TTY' && /登录|login|权限|403|401/.test(err.message)) {
    console.error('建议：加 --wait-login 参数，在打开的浏览器里登录后回车再抓取。');
  }
  process.exit(1);
});
