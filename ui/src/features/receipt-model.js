/**
 * 导出回执的纯数据模型 —— 不含任何 JSX，因此可以在纯 Node 下用 node:test 直接测。
 *
 * 铁律：**每一个数字都必须能在 manifest.json 里找到同名字段**，不允许推算或编造。
 * 字段缺失时返回 null，由视图层显示 "—"。
 */

/** @param {unknown} v @returns {number|null} */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** @param {unknown} types @returns {number|null} */
function countTypes(types) {
  if (!types || typeof types !== 'object') return null;
  return Object.values(types).reduce((sum, n) => sum + (num(n) || 0), 0);
}

/** @param {unknown} arr @returns {unknown[]} */
function arr(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * @param {object|null|undefined} manifest
 * @returns {object|null} 回执模型；manifest 非法时返回 null
 */
export function buildReceipt(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;

  const assets = manifest.assets && typeof manifest.assets === 'object' ? manifest.assets : {};
  const outputs = manifest.outputs && typeof manifest.outputs === 'object' ? manifest.outputs : null;

  return {
    title: typeof manifest.title === 'string' ? manifest.title : null,
    sourceUrl: typeof manifest.sourceUrl === 'string' ? manifest.sourceUrl : null,
    docId: typeof manifest.docId === 'string' ? manifest.docId : null,
    exportedAt: typeof manifest.exportedAt === 'string' ? manifest.exportedAt : null,
    browser: typeof manifest.browser === 'string' ? manifest.browser : null,
    blockCount: num(manifest.blockCount),
    renderedBlocks: num(manifest.renderedBlocks),
    unsupportedCount: countTypes(manifest.unsupportedTypes),
    degradedCount: num(manifest.degradedCount),
    renderErrorCount: arr(manifest.renderErrors).length,
    danglingCount: arr(manifest.danglingRefs).length,
    truncated: manifest.truncated === true,
    pagesFetched: num(manifest.pagesFetched),
    assetsTotal: num(assets.total),
    assetsSaved: num(assets.saved),
    assetsMissing: arr(assets.missing),
    assetsSkipped: arr(assets.skipped),
    warnings: arr(manifest.warnings),
    outputs
  };
}

/**
 * 完整性判定。只有"没有任何一处缺口"才算 complete。
 * @param {ReturnType<typeof buildReceipt>} receipt
 * @returns {'complete'|'partial'|'unknown'}
 */
export function integrityOf(receipt) {
  if (!receipt) return 'unknown';
  const hasGap =
    receipt.truncated ||
    (receipt.unsupportedCount ?? 0) > 0 ||
    (receipt.renderErrorCount ?? 0) > 0 ||
    (receipt.danglingCount ?? 0) > 0 ||
    (receipt.assetsMissing?.length ?? 0) > 0 ||
    (receipt.assetsSkipped?.length ?? 0) > 0;
  return hasGap ? 'partial' : 'complete';
}

/**
 * 把任务结果转成可用于预览/下载的 URL。
 * @param {object|null} result server 返回的 `job.result`（形如 { results: [...] }）
 * @returns {{previewUrl: string|null, htmlName: string|null, title: string|null}}
 */
export function previewTargetOf(result) {
  const first = result?.results?.[0];
  if (!first || !first.outDir) return { previewUrl: null, htmlName: null, title: null };
  const title = String(first.outDir).split(/[\\/]/).pop();
  const htmlName = first.manifest?.outputs?.html ?? null;
  if (!title || !htmlName) return { previewUrl: null, htmlName, title };
  return {
    previewUrl: `/preview/${encodeURIComponent(title)}/${encodeURIComponent(htmlName)}`,
    htmlName,
    title
  };
}
