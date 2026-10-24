/**
 * Token 自查页 —— S1 阶段的验收物，不是交付功能。
 * 一屏列全色板 / 字阶 / 三种状态 / 三处动效，用来确认设计系统落地没走样。
 * 通过 URL hash `#tokens` 进入，不影响正常工作台。
 */

const COLORS = [
  { name: '--paper', label: '暖纸基底', cls: 'bg-paper' },
  { name: '--paper-2', label: '次级面', cls: 'bg-paper-2' },
  { name: '--ink', label: '墨黑正文', cls: 'bg-ink' },
  { name: '--ink-soft', label: '次级文字', cls: 'bg-ink-soft' },
  { name: '--rule', label: '规则线 / 栅格', cls: 'bg-rule' },
  { name: '--signal', label: '氧化橙（活跃 / 警示）', cls: 'bg-signal' },
  { name: '--go', label: '深铬绿（完成）', cls: 'bg-go' }
];

const STEPS = [
  { cls: 'text-[11px]', label: '11 · 编号/标签' },
  { cls: 'text-[13px]', label: '13 · 数据/路径' },
  { cls: 'text-[15px]', label: '15 · 正文' },
  { cls: 'text-[19px]', label: '19 · 小节' },
  { cls: 'text-[24px]', label: '24 · 区块标题' },
  { cls: 'text-[34px]', label: '34 · 页标题' }
];

const STATES = [
  { label: 'queued', color: 'bg-ink-soft', note: '灰点' },
  { label: 'running', color: 'bg-signal', note: '氧化橙' },
  { label: 'waiting_login', color: 'bg-signal', note: '氧化橙 + 文案' },
  { label: 'done', color: 'bg-go', note: '深铬绿' },
  { label: 'error', color: 'bg-signal', note: '实心 + 原因' },
  { label: 'cancelled', color: 'bg-ink-soft', note: '灰斜线' }
];

export default function TokensPreview() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-gutter">
      <p className="secno">S1 · token 自查</p>
      <h1 className="mt-2 font-display text-[34px] leading-tight">图纸档案终端 · 设计系统</h1>
      <p className="mono mt-2 text-[13px] text-ink-soft">
        暖纸 + 墨黑 + 单一氧化橙；衬线标题 / 等宽数据；圆角统一 2px；全站只允许三处动效。
      </p>

      <hr className="hr my-10" />

      <h2 className="mono text-[13px] uppercase tracking-[0.18em] text-ink-soft">色板</h2>
      <div className="mt-4 grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
        {COLORS.map((c) => (
          <div key={c.name} className="bg-paper p-3">
            <div className={`${c.cls} h-12 w-full border border-rule`} />
            <div className="mono mt-2 text-[11px] text-ink-soft">{c.name}</div>
            <div className="text-[13px]">{c.label}</div>
          </div>
        ))}
      </div>

      <h2 className="mono mt-10 text-[13px] uppercase tracking-[0.18em] text-ink-soft">字阶</h2>
      <div className="mt-4 space-y-2">
        {STEPS.map((s) => (
          <div key={s.label} className="flex items-baseline gap-4 border-b border-rule pb-2">
            <span className={`${s.cls} mono`}>Aa 飞书导出</span>
            <span className="mono text-[11px] text-ink-soft">{s.label}</span>
          </div>
        ))}
      </div>

      <h2 className="mono mt-10 text-[13px] uppercase tracking-[0.18em] text-ink-soft">状态语义</h2>
      <div className="mt-4 space-y-2">
        {STATES.map((s) => (
          <div key={s.label} className="flex items-center gap-3">
            <span className={`${s.color} inline-block h-2.5 w-2.5 rounded-full`} />
            <span className="mono text-[13px]">{s.label}</span>
            <span className="mono text-[11px] text-ink-soft">{s.note}</span>
          </div>
        ))}
      </div>

      <h2 className="mono mt-10 text-[13px] uppercase tracking-[0.18em] text-ink-soft">按钮与输入</h2>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn">主操作</button>
        <button type="button" className="btn btn-ghost">次要</button>
        <button type="button" className="btn btn-signal">危险</button>
        <button type="button" className="btn" disabled>禁用</button>
      </div>
      <input className="field mt-3" placeholder="https://xxx.feishu.cn/docx/…" readOnly />

      <h2 className="mono mt-10 text-[13px] uppercase tracking-[0.18em] text-ink-soft">三处动效</h2>
      <p className="mono mt-2 text-[11.5px] text-ink-soft">
        刷新页面可观察；系统开启"减少动态效果"时应全部归零。
      </p>
      <div className="mt-4 flex flex-wrap gap-6">
        <span className="anim-slot hairline bg-paper-2 px-3 py-1.5 text-[13px]">① 入槽</span>
        <span className="inline-flex items-center gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className="anim-dot inline-block h-2 w-2 rounded-full bg-signal"
              style={{ animationDelay: `${i * 40}ms` }}
            />
          ))}
          <span className="mono ml-1 text-[11px] text-ink-soft">② 阶段点阵</span>
        </span>
        <span className="anim-reveal hairline bg-paper-2 px-3 py-1.5 text-[13px]">③ 产物揭示</span>
      </div>
    </div>
  );
}
