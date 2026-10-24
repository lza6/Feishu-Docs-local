import { useEffect, useMemo, useState } from 'react';
import { useJobs } from './hooks/useJobs.js';
import Submit from './features/Submit.jsx';
import JobList from './features/JobList.jsx';
import Receipt, { Preview } from './features/Receipt.jsx';
import TokensPreview from './dev/TokensPreview.jsx';

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // S1 自查页：只在 #tokens 时出现，不占正常入口
  if (hash === '#tokens') return <TokensPreview />;

  return <Workspace />;
}

function Workspace() {
  const { jobs, health, connected, error, submit, cancel, resumeLogin } = useJobs();
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(false);

  // 没有手动选择时，自动选中最近完成的一个，省一次点击
  useEffect(() => {
    if (selectedId) return;
    const done = jobs.find((j) => j.status === 'done');
    if (done) setSelectedId(done.id);
  }, [jobs, selectedId]);

  const selected = useMemo(() => jobs.find((j) => j.id === selectedId) ?? null, [jobs, selectedId]);

  async function handleSubmit(body) {
    setBusy(true);
    try {
      return await submit(body);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-end justify-between gap-4 px-5 py-8">
          <div>
            <p className="secno">飞书导出 · 本地工作台</p>
            <h1
              className="mt-2 font-display leading-[1.1]"
              style={{ fontSize: 'clamp(1.9rem, 1rem + 3vw, 3.2rem)' }}
            >
              把文档取下来，并证明它是全的
            </h1>
          </div>
          <div className="mono space-y-0.5 text-[11.5px] text-ink-soft">
            <div className={connected ? 'text-go' : 'text-signal'}>
              {connected ? '● 实时连接已建立' : '○ 实时连接断开（自动重连中）'}
            </div>
            <div>{health?.browser ?? '浏览器未就绪'}</div>
            <div>服务端口 {health?.port ?? '—'}</div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1280px] px-5 pb-24">
        {/* 必须显式 grid-cols-1：隐性单列的列宽会被子元素 min-content 撑开，窄屏直接横向溢出 */}
        <div className="grid grid-cols-1 gap-x-10 gap-y-12 lg:grid-cols-[minmax(320px,1fr)_minmax(0,1.618fr)]">
          <section className="min-w-0 pt-8 lg:sticky lg:top-6 lg:self-start">
            <p className="secno">01 投入</p>
            <h2 className="mt-1 font-display text-[19px]">粘贴链接</h2>
            <div className="mt-4">
              <Submit onSubmit={handleSubmit} busy={busy} />
            </div>
          </section>

          <div className="min-w-0 pt-8">
            <section>
              <p className="secno">02 队列</p>
              <h2 className="mt-1 font-display text-[19px]">导出进度</h2>

              {error && (
                <p
                  role="alert"
                  className="mono mt-3 border-l-2 border-signal bg-paper-2 px-3 py-2 text-[12.5px] text-signal"
                >
                  {error}
                </p>
              )}

              <div className="mt-4 border-t border-rule">
                <JobList
                  jobs={jobs}
                  onCancel={cancel}
                  onResume={resumeLogin}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              </div>
            </section>

            <section className="mt-14">
              <p className="secno">03 产物</p>
              <h2 className="mt-1 font-display text-[19px]">回执与预览</h2>
              <div className="mt-4 max-w-[620px]">
                <Receipt job={selected} />
              </div>
              <div className="mt-8">
                <Preview job={selected} />
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
