/** 页面探测（调试用）：输出 URL/标题/正文摘要，并截图 */
import fs from 'node:fs';
import { CDP, sleep } from './lib/cdp.mjs';
const [url, shotPath] = process.argv.slice(2);
const cdp = await CDP.connect(9222);
console.log('已连接:', cdp.browserVersion);
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);
const navResult = await Promise.race([
  cdp.send('Page.navigate', { url }, sessionId).then(r => 'ok:' + (r.errorText || 'navigated')),
  sleep(20000).then(() => 'timeout')
]);
console.log('导航:', navResult);
await sleep(8000);
const info = await Promise.race([
  cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify({url:location.href,title:document.title,len:(document.body.innerText||"").length,login:/登录|扫码|Sign in/.test((document.body.innerText||"").slice(0,2000)),head:(document.body.innerText||"").slice(0,400)})',
    returnByValue: true
  }, sessionId).then(r => r.result.value),
  sleep(10000).then(() => '(eval 超时)')
]);
console.log('页面:', info);
if (shotPath) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('截图:', shotPath);
}
await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
await cdp.close();
