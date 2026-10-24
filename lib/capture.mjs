/**
 * 页面内抓取逻辑：调用飞书文档自身的 client_vars 接口，拿到全量 block 数据；
 * 再按 token 把图片/白板/附件拉成 base64。
 */

/**
 * @param {string} docId 文档 token（URL 中 /docx/<id> 或 /docs/<id>）
 * @param {number} assetChunk 每批拉取的资源数（避免单次 CDP 消息过大）
 * @param {number[]} chunkIndexes 本次要拉的批次下标；不传则只返回待拉清单
 */
export async function captureDoc(docId, chunkIndexes = null, assetChunk = 8, maxAssetBytes = null) {
  const state = (window.__feishuExport ||= {});

  // 页面刚导航完就发 fetch 可能被中断（TypeError: Failed to fetch）。
  // 本函数会被 toString() 注入页面独立执行，因此重试器必须定义在函数体内。
  const fetchRetry = async (u, opts = {}, attempts = 4) => {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fetch(u, opts);
      } catch (e) {
        lastErr = e;
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 700 * Math.pow(2, i)));
      }
    }
    throw new Error(`请求失败（已重试 ${attempts} 次）：${(lastErr && lastErr.message) || '未知错误'} · ${u}`);
  };

  // ---------- 1. 拉取全量 block ----------
  if (!state.blocks) {
    const MAX_PAGES = 200; // 每页 239 块 → 约 4.7 万块上限
    const all = { block_map: {}, fetched: 0, pages: 0, hasMore: false, truncated: false };
    let cursor = '';
    for (let i = 0; i < MAX_PAGES; i++) {
      const url = `/space/api/docx/pages/client_vars?id=${encodeURIComponent(docId)}&mode=7&limit=239${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await fetchRetry(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`client_vars 接口返回 HTTP ${res.status}`);
      const json = await res.json();
      const data = json.data || {};
      if (json.code !== 0 && !data.block_map) throw new Error(`接口返回异常: ${json.msg || json.code}`);
      Object.assign(all.block_map, data.block_map || {});
      all.pages++;
      if (!data.has_more) { all.hasMore = false; break; }
      const next = (data.next_cursors && data.next_cursors[0]) || data.cursor;
      if (!next || next === cursor) break;
      cursor = next;
      all.hasMore = true;
    }
    // 循环耗尽却仍 hasMore → 说明被 MAX_PAGES 截断，必须对外暴露（P1-4，原 hasMore 是死字段）
    all.truncated = all.hasMore === true;
    all.fetched = Object.keys(all.block_map).length;
    if (!all.fetched) throw new Error('未取到任何内容块（可能需要登录，或该文档未公开）');
    state.blocks = all;
  }

  const bm = state.blocks.block_map;
  const root = bm[docId] || {};

  // ---------- 2. 收集资源 token ----------
  if (!state.assets) {
    const list = [];
    for (const [id, b] of Object.entries(bm)) {
      const d = (b && b.data) || {};
      if (d.type === 'image' && d.image && d.image.token) {
        list.push({ id, kind: 'image', token: d.image.token, mime: d.image.mimeType || '' });
      } else if (d.type === 'whiteboard' && d.token) {
        list.push({ id, kind: 'whiteboard', token: d.token });
      } else if (d.type === 'file' && d.file && d.file.token) {
        list.push({ id, kind: 'file', token: d.file.token, name: d.file.name || '', mime: d.file.mimeType || '' });
      } else if (d.type === 'media' && (d.file_token || d.token)) {
        // 视频/音频：与附件走同一路下载（P1-7 第一期只补这一类；sheet/bitable 需另外的导出接口，成本高于收益）
        list.push({ id, kind: 'media', token: d.file_token || d.token, name: d.file_name || d.name || '', mime: d.mime_type || '' });
      }
    }
    state.assets = list;
    state.assetData = {};
  }

  const list = state.assets;
  const totalChunks = Math.ceil(list.length / assetChunk);

  const toBase64 = blob => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('FileReader 失败'));
    fr.readAsDataURL(blob);
  });

  const urlsFor = item => {
    if (item.kind === 'image') return [`/space/api/box/stream/download/preview/${item.token}/?preview_type=16`];
    if (item.kind === 'whiteboard') {
      return [
        `/space/api/file/f/cdp-whiteboard-${item.token}~noop/`,
        `/space/api/box/stream/download/preview/${item.token}/?preview_type=16`
      ];
    }
    return [
      `/space/api/box/stream/download/all/${item.token}/`,
      `/space/api/box/stream/download/preview/${item.token}/?preview_type=16`,
      `/space/api/file/f/${item.token}~noop/`
    ];
  };

  // 探查语义：null = 只返回资源清单、不下载；[] = 什么都不做；数组 = 下载指定批次
  const probing = chunkIndexes === null;
  const wanted = probing ? [] : (chunkIndexes ?? [...Array(totalChunks).keys()]);
  const DEFAULT_MAX_ASSET_BYTES = 128 * 1024 * 1024;
  const MAX_ASSET_BYTES = Number.isFinite(maxAssetBytes) && maxAssetBytes > 0 ? maxAssetBytes : DEFAULT_MAX_ASSET_BYTES;
  const batchTokens = new Set();            // 只回传本批新增成功的项，避免全量重复传输 O(n²)（P1-3）
  const batchSkipped = [];                  // 只回传本批新增的跳过项（否则每批都重复上报同一批）

  for (const ci of wanted) {
    const slice = list.slice(ci * assetChunk, (ci + 1) * assetChunk);
    for (const item of slice) {
      const cached = state.assetData[item.token];
      if (cached?.ok || cached?.skipped) continue;
      state.assetData[item.token] = { ok: false, kind: item.kind };
      for (const u of urlsFor(item)) {
        try {
          const res = await fetchRetry(u, { credentials: 'include' }, 2);
          const ct = res.headers.get('content-type') || '';
          if (res.ok && /^image\/|octet-stream|text\/|application\//.test(ct)) {
            const blob = await res.blob();
            if (blob.size > MAX_ASSET_BYTES) {
              state.assetData[item.token] = { ok: false, skipped: true, kind: item.kind, size: blob.size, reason: 'exceeds MAX_ASSET_BYTES' };
              batchSkipped.push({ token: item.token, kind: item.kind, size: blob.size });
              break;
            }
            state.assetData[item.token] = {
              ok: true,
              kind: item.kind,
              ct,
              name: item.name || '',
              size: blob.size,
              b64: await toBase64(blob)
            };
            batchTokens.add(item.token);
            break;
          }
        } catch { /* 换下一个候选地址 */ }
      }
    }
  }

  const done = list.filter(a => state.assetData[a.token]?.ok).length;
  return {
    docId,
    blockCount: Object.keys(bm).length,
    rootChildren: (root.data && root.data.children ? root.data.children.length : 0),
    title: ((root.data && root.data.text && root.data.text.initialAttributedTexts &&
      root.data.text.initialAttributedTexts.text && root.data.text.initialAttributedTexts.text['0']) || document.title || '').replace(/​/g, '').trim(),
    assetTotal: list.length,
    assetDone: done,
    totalChunks,
    truncated: state.blocks.truncated === true,
    pagesFetched: state.blocks.pages,
    // 清单始终返回：manifest.assets.missing 的判定依赖它。
    // 原实现只在 chunkIndexes === null 时返回，而调用方传的是 []，导致 probe.assets
    // 恒为 undefined → missing 恒为 []（证据链失真，P1-2）。
    assets: list.map(a => ({ token: a.token, kind: a.kind, name: a.name || '' })),
    skippedAssets: batchSkipped,
    // 只回传本批新增成功的项，避免全量重复传输（P1-3）
    assetPayload: Object.fromEntries(
      [...batchTokens].map(t => {
        const v = state.assetData[t];
        return [t, { ok: true, ct: v.ct, name: v.name, kind: v.kind, size: v.size, b64: v.b64 }];
      })
    )
  };
}

/** 只取 block 数据（不含资源），用于快速探测 */
export async function captureBlocks(docId) {
  return captureDoc(docId, null, 8);
}
