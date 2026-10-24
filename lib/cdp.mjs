/**
 * 极简 Chrome DevTools Protocol 客户端（零依赖，基于 Node >= 20 内置 WebSocket）
 * 只实现本项目需要的部分：目标管理、会话附加、导航、执行 JS。
 */
import { setTimeout as sleep } from 'node:timers/promises';

// Node 20 没有全局 WebSocket（需 --experimental-websocket），21 起默认启用、22 起稳定。
// 提前给出可执行提示，避免用户撞上 `ReferenceError: WebSocket is not defined`（P1-5）
if (typeof WebSocket === 'undefined') {
  throw new Error(
    `当前 Node ${process.version} 没有全局 WebSocket。本项目要求 Node >= 22；`
    + '若必须用 Node 20，请以 `node --experimental-websocket` 运行。'
  );
}

export class CDP {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();

  static async connect(port = 9222, host = '127.0.0.1') {
    const res = await fetch(`http://${host}:${port}/json/version`);
    if (!res.ok) throw new Error(`CDP 端口 ${port} 无响应: HTTP ${res.status}`);
    const info = await res.json();
    const cdp = new CDP();
    await cdp.#open(info.webSocketDebuggerUrl);
    cdp.browserVersion = info.Browser;
    return cdp;
  }

  async #open(wsUrl) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.#ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
          this.#ws.addEventListener('open', resolve, { once: true });
          this.#ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
        });
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        await sleep(300);
      }
    }
    this.#ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.id && this.#pending.has(msg.id)) {
        const { resolve, reject, timer } = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
      }
    });
    this.#ws.addEventListener('close', () => {
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(new Error('CDP 连接已关闭'));
      }
      this.#pending.clear();
    });
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, []);
    this.#listeners.get(method).push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      // 超时定时器必须 unref 且在 settle 时 clear：
      // 原来"只注册不清理"，每个 send 都挂一个 180s 定时器，
      // 导致导出跑完后进程仍要等最后一个定时器到期才退出（用户误判卡死，P1-1）。
      const timer = setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`CDP 调用超时: ${method}`));
        }
      }, 180_000);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#ws.send(JSON.stringify(payload));
    });
  }

  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    return { targetId, sessionId };
  }

  async close() {
    try { this.#ws?.close(); } catch { /* ignore */ }
  }
}

/** 把 JS 函数表达式在页面里执行并取回结果（支持 await） */
export async function evaluate(cdp, sessionId, expressionOrFn, timeout = 180_000) {
  const expression = typeof expressionOrFn === 'function'
    ? `(${expressionOrFn.toString()})()`
    : expressionOrFn;
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }, sessionId);
  if (exceptionDetails) {
    const desc = exceptionDetails.exception?.description || exceptionDetails.text;
    throw new Error(`页面内执行异常: ${desc}`);
  }
  return result.value;
}

export async function waitForReady(cdp, sessionId, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await evaluate(cdp, sessionId, 'document.readyState');
    if (state === 'complete') return true;
    await sleep(400);
  }
  return false;
}

export { sleep };
