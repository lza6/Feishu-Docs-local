import { useState } from 'react';

/**
 * 投入区：一行一个链接，粘贴即用。
 * @param {{onSubmit: (body: {urls: string[], opts: {md: boolean, waitLogin: boolean}}) => Promise<unknown>, busy: boolean}} props
 */
export default function Submit({ onSubmit, busy }) {
  const [text, setText] = useState('');
  const [noMd, setNoMd] = useState(false);
  const [waitLogin, setWaitLogin] = useState(false);
  const [localError, setLocalError] = useState(null);

  const urls = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!urls.length) {
      setLocalError('至少粘贴一个飞书文档链接（/docx/、/docs/ 或 /wiki/）');
      return;
    }
    setLocalError(null);
    try {
      await onSubmit({ urls, opts: { md: !noMd, waitLogin } });
      setText('');
    } catch (err) {
      setLocalError(err.message);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="urls" className="mono block text-[11.5px] uppercase tracking-[0.18em] text-ink-soft">
        文档链接（一行一个）
      </label>
      <textarea
        id="urls"
        className="field mt-2"
        rows={5}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'https://xxx.feishu.cn/docx/AbCdEf123\nhttps://xxx.feishu.cn/docx/GhIjKl456'}
      />

      <div className="mono mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px]">
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={noMd} onChange={(e) => setNoMd(e.target.checked)} />
          不生成 Markdown
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={waitLogin} onChange={(e) => setWaitLogin(e.target.checked)} />
          需要登录（在浏览器里登录后再点"继续"）
        </label>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button type="submit" className="btn" disabled={busy || !urls.length}>
          {busy ? '提交中…' : `导出${urls.length > 1 ? ` ${urls.length} 篇` : ''}`}
        </button>
        <span className="mono text-[11.5px] text-ink-soft">
          {urls.length ? `已识别 ${urls.length} 个链接` : '等待粘贴'}
        </span>
      </div>

      {localError && (
        <p className="mono mt-3 border-l-2 border-signal bg-paper-2 px-3 py-2 text-[12.5px] text-signal" role="alert">
          {localError}
        </p>
      )}
    </form>
  );
}
