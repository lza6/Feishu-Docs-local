/**
 * 页面内抓取逻辑：调用飞书文档自身的 client_vars 接口，拿到全量 block 数据；
 * 再按 token 把图片/白板/附件拉成 base64。
 */

/**
 * @param {string} docId 文档 token（URL 中 /docx/<id> 或 /docs/<id>）
 * @param {number} assetChunk 每批拉取的资源数（避免单次 CDP 消息过大）
 * @param {number[]} chunkIndexes 本次要拉的批次下标；不传则只返回待拉清单
 */
export async function captureDoc(docId, chunkIndexes = null, assetChunk = 8) {
  const state = (window.__feishuExport ||= {});

  // ---------- 1. 拉取全量 block ----------
  if (!state.blocks) {
    const all = { block_map: {}, fetched: 0, pages: 0, hasMore: false };
    let cursor = '';
    for (let i = 0; i < 200; i++) {
      const url = `/space/api/docx/pages/client_vars?id=${encodeURIComponent(docId)}&mode=7&limit=239${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await fetch(url, { credentials: 'include' });
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

  const wanted = chunkIndexes ?? [...Array(totalChunks).keys()];
  for (const ci of wanted) {
    const slice = list.slice(ci * assetChunk, (ci + 1) * assetChunk);
    for (const item of slice) {
      if (state.assetData[item.token]?.ok) continue;
      state.assetData[item.token] = { ok: false, kind: item.kind };
      for (const u of urlsFor(item)) {
        try {
          const res = await fetch(u, { credentials: 'include' });
          const ct = res.headers.get('content-type') || '';
          if (res.ok && /^image\/|octet-stream|text\/|application\//.test(ct)) {
            const blob = await res.blob();
            state.assetData[item.token] = {
              ok: true,
              kind: item.kind,
              ct,
              name: item.name || '',
              size: blob.size,
              b64: await toBase64(blob)
            };
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
    assets: chunkIndexes === null ? list.map(a => ({ token: a.token, kind: a.kind, name: a.name || '' })) : undefined,
    assetPayload: chunkIndexes === null ? undefined : Object.fromEntries(
      Object.entries(state.assetData)
        .filter(([, v]) => v.ok)
        .map(([k, v]) => [k, { ok: true, ct: v.ct, name: v.name, kind: v.kind, size: v.size, b64: v.b64 }])
    )
  };
}

/** 只取 block 数据（不含资源），用于快速探测 */
export async function captureBlocks(docId) {
  return captureDoc(docId, null, 8);
}
