const STAGES = [
  { key: 'probe', label: '取块' },
  { key: 'assets', label: '资源' },
  { key: 'render', label: '渲染' },
  { key: 'write', label: '落盘' }
];

// 阶段先后次序：用来把一个 phase 映射成"走到第几格"
const ORDER = [
  'queued', 'starting', 'launch', 'cdp', 'job_url', 'navigate',
  'slow_page', 'waiting_login', 'probe', 'assets', 'blocks', 'render', 'write', 'done'
];

const STATUS_STYLE = {
  queued: { dot: 'bg-ink-soft', text: 'text-ink-soft', label: '排队中' },
  running: { dot: 'bg-signal', text: 'text-ink', label: '导出中' },
  waiting_login: { dot: 'bg-signal', text: 'text-signal', label: '等待登录' },
  done: { dot: 'bg-go', text: 'text-go', label: '完成' },
  error: { dot: 'bg-signal', text: 'text-signal', label: '失败' },
  cancelled: { dot: 'bg-ink-soft', text: 'text-ink-soft', label: '已取消' }
};

const at = (phase) => ORDER.indexOf(phase);

/**
 * 队列区：一行一个任务，四格点阵表示阶段推进。
 * @param {{jobs: Array<object>, onCancel: Function, onResume: Function, selectedId: string|null, onSelect: Function}} props
 */
export default function JobList({ jobs, onCancel, onResume, selectedId, onSelect }) {
  if (!jobs.length) {
    return (
      <p className="mono py-10 text-center text-[12.5px] text-ink-soft">
        还没有任务。左边粘贴链接开始。
      </p>
    );
  }

  return (
    <ul className="divide-y divide-rule">
      {jobs.map((job, i) => {
        const style = STATUS_STYLE[job.status] ?? STATUS_STYLE.queued;
        const cur = at(job.phase);
        const isSelected = job.id === selectedId;
        const progress = job.progress;

        return (
          <li
            key={job.id}
            className={`anim-slot py-3 ${isSelected ? 'bg-paper-2' : ''}`}
            style={{ animationDelay: `${Math.min(i, 6) * 40}ms` }}
          >
            <div className="flex items-start gap-3">
              <span
                className={`${style.dot} mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${job.status === 'running' ? 'anim-dot' : ''}`}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => onSelect(job.id)}
                  className="mono w-full truncate text-left text-[13px] hover:underline"
                  title={job.urls?.[0]}
                >
                  {job.urls?.[0] ?? job.id}
                </button>

                <div className="mono mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-soft">
                  <span className={style.text}>{style.label}</span>
                  {job.phase && job.phase !== 'queued' && <span>· {job.phase}</span>}
                  {progress && (
                    <span>
                      · 资源 {progress.done ?? 0}/{progress.assetTotal ?? 0}
                    </span>
                  )}
                  {job.error?.message && (
                    <span className="text-signal">· {job.error.message}</span>
                  )}
                </div>

                <div className="mt-2 flex items-center gap-2">
                  {STAGES.map((s) => {
                    const reached = cur > at(s.key);
                    const current = cur === at(s.key) || (job.phase === s.key);
                    return (
                      <span key={s.key} className="flex items-center gap-1">
                        <span
                          className={`inline-block h-1.5 w-6 ${
                            reached || current ? 'bg-signal' : 'bg-rule'
                          } ${current && job.status === 'running' ? 'anim-dot' : ''}`}
                          aria-hidden="true"
                        />
                        <span className="mono text-[10.5px] text-ink-soft">{s.label}</span>
                      </span>
                    );
                  })}
                </div>
              </div>

              <div className="flex shrink-0 gap-2">
                {job.status === 'waiting_login' && (
                  <button type="button" className="btn btn-signal text-[12px]" onClick={() => onResume(job.id)}>
                    登录好了，继续
                  </button>
                )}
                {(job.status === 'queued' || job.status === 'running' || job.status === 'waiting_login') && (
                  <button type="button" className="btn btn-ghost text-[12px]" onClick={() => onCancel(job.id)}>
                    取消
                  </button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
