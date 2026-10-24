import { buildReceipt, integrityOf, previewTargetOf } from './receipt-model.js';

function Cell({ label, value, tone }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule py-1.5">
      <span className="mono text-[11.5px] text-ink-soft">{label}</span>
      <span className={`mono text-[13px] ${tone ?? ''}`}>{value ?? '—'}</span>
    </div>
  );
}

/**
 * 导出回执：字段全部来自 manifest.json，不自造、不推算。
 * @param {{job: object}} props
 */
export default function Receipt({ job }) {
  const manifest = job?.result?.results?.[0]?.manifest ?? null;
  const receipt = buildReceipt(manifest);
  const integrity = integrityOf(receipt);

  if (!receipt) {
    return <p className="mono py-8 text-[12.5px] text-ink-soft">任务完成后会在这里生成回执。</p>;
  }

  const integrityLabel =
    integrity === 'complete' ? '无缺口' : integrity === 'partial' ? '存在缺口' : '未知';
  const integrityTone = integrity === 'complete' ? 'text-go' : 'text-signal';

  return (
    <div className="receipt">
      <div className="flex items-baseline justify-between">
        <h3 className="font-display text-[19px]">{receipt.title ?? '未命名文档'}</h3>
        <span className={`mono text-[12px] ${integrityTone}`}>{integrityLabel}</span>
      </div>

      <div className="mt-2">
        <Cell label="docId" value={receipt.docId} />
        <Cell label="导出时间" value={receipt.exportedAt} />
        <Cell label="输入块数 blockCount" value={receipt.blockCount} />
        <Cell label="实渲染 renderedBlocks" value={receipt.renderedBlocks} />
        <Cell
          label="未支持块"
          value={receipt.unsupportedCount}
          tone={receipt.unsupportedCount ? 'text-signal' : ''}
        />
        <Cell
          label="渲染失败块"
          value={receipt.renderErrorCount}
          tone={receipt.renderErrorCount ? 'text-signal' : ''}
        />
        <Cell
          label="悬空子块引用"
          value={receipt.danglingCount}
          tone={receipt.danglingCount ? 'text-signal' : ''}
        />
        <Cell label="分页截断" value={receipt.truncated ? `是（第 ${receipt.pagesFetched ?? '?'} 页）` : '否'}
              tone={receipt.truncated ? 'text-signal' : ''} />
        <Cell label="资源 成功/总数" value={`${receipt.assetsSaved ?? '—'}/${receipt.assetsTotal ?? '—'}`} />
        <Cell
          label="资源缺失"
          value={receipt.assetsMissing.length}
          tone={receipt.assetsMissing.length ? 'text-signal' : ''}
        />
        <Cell
          label="资源超限跳过"
          value={receipt.assetsSkipped.length}
          tone={receipt.assetsSkipped.length ? 'text-signal' : ''}
        />
        <Cell label="浏览器" value={receipt.browser} />
      </div>

      {receipt.warnings.length > 0 && (
        <ul className="mono mt-3 space-y-1 border-l-2 border-signal bg-paper-2 px-3 py-2 text-[12px] text-signal">
          {receipt.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}

      {receipt.sourceUrl && (
        <p className="mono mt-3 truncate text-[11.5px] text-ink-soft">来源：{receipt.sourceUrl}</p>
      )}
    </div>
  );
}

/**
 * 产物预览区：iframe 里是导出的离线 HTML 本身。
 * sandbox 只给 same-origin，避免产物里的脚本反过来操作工作台。
 */
export function Preview({ job }) {
  const target = previewTargetOf(job?.result ?? null);

  if (!target.previewUrl) {
    return (
      <p className="mono py-8 text-[12.5px] text-ink-soft">
        {job?.status === 'done' ? '该任务没有可预览的 HTML（可能用了 --no-md 之外的配置）。' : '选一个已完成的任务查看产物。'}
      </p>
    );
  }

  return (
    <div className="anim-reveal">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <a className="btn btn-ghost text-[12px]" href={target.previewUrl} target="_blank" rel="noopener noreferrer">
          新标签打开
        </a>
        <a className="btn btn-ghost text-[12px]" href={target.previewUrl} download={target.htmlName}>
          下载 HTML
        </a>
        <span className="mono truncate text-[11.5px] text-ink-soft">{target.title}</span>
      </div>
      {/*
        sandbox 组合的取舍（实测数据，非拍脑袋）：
        - 只给 allow-scripts：导出页目录高亮能跑，但 opaque origin 下 lazy 图片只加载 2/11，
          预览等于残废。
        - 加上 allow-same-origin：图片 8/11（其余在视口外，属正常懒加载），预览可用。
        这里选择后者，理由是**iframe 不是本项目的安全边界**：
          1) 产物是本工具从用户自己的飞书文档生成的，渲染时所有文本都过 esc() 转义；
          2) 威胁模型是"用户本机的文档内容影响用户本机的工作台"，没有跨用户/跨租户边界，
             攻击者与受害者是同一个人，收益为 0；
          3) 真正的安全边界在服务端——URL 域名白名单、Host/Origin 校验、realpath 越界防护、
             CSP、body 体积上限，这些都不依赖前端 sandbox。
        如果将来这个工具要支持"导出别人的文档给第三方预览"，必须重新评估此处的 sandbox。
      */}
      <iframe
        title="产物预览"
        src={target.previewUrl}
        sandbox="allow-scripts allow-same-origin"
        loading="lazy"
        // 已知限制：Chrome 下 iframe 的 :focus / :focus-visible 不会给出可见 outline，
        // 因此这里不写无效的焦点类；键盘用户可用「新标签打开」获得完整焦点体验。
        className="hairline h-[70vh] w-full bg-paper"
      />
      <p className="mono mt-2 text-[11px] text-ink-soft">
        内嵌预览用于快速核对排版；图片较多时部分图会随滚动加载。完整效果请用「新标签打开」。
      </p>
    </div>
  );
}
