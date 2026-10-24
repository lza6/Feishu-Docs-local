/**
 * 编排层纯函数回归用例 —— 目录解析（P2-9）、路径安全（P2-5）、标题清洗。
 * 无浏览器、无网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { safeName, assertInsideOut, resolveOutDir } from '../lib/driver.mjs';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-drv-'));
}

// ---------------- safeName（P2-5） ----------------

test('safeName：纯点号标题不得成为目录名', () => {
  for (const evil of ['..', '.', '...', '']) {
    const got = safeName(evil, 'untitled-abc12345');
    assert.notEqual(got, '..');
    assert.notEqual(got, '.');
    assert.ok(got.length > 0, `"${evil}" 必须回退到非空名称`);
  }
  assert.equal(safeName('..', 'untitled-abc12345'), 'untitled-abc12345');
});

test('safeName：非法字符替换、空白折叠、长度截断', () => {
  assert.equal(safeName('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i');
  assert.equal(safeName('  多   空格  '), '多 空格');
  assert.equal(safeName('x'.repeat(200)).length, 80);
});

test('safeName：正常标题原样保留', () => {
  assert.equal(safeName('Pytest脚本开发流程说明'), 'Pytest脚本开发流程说明');
});

// ---------------- assertInsideOut（P2-5） ----------------

test('assertInsideOut：越界路径必须抛错', () => {
  const root = path.join(os.tmpdir(), 'out-root');
  assert.throws(() => assertInsideOut(root, path.join(root, '..', 'evil')), /BAD_PATH|越界|不在/);
  assert.doesNotThrow(() => assertInsideOut(root, path.join(root, 'doc')));
});

// ---------------- resolveOutDir（P2-9 数据丢失） ----------------

test('P2-9：目录不存在时直接用标题', () => {
  const root = tmpRoot();
  try {
    const r = resolveOutDir(root, '某文档', 'DOCIDAAA');
    assert.equal(r.reused, false);
    assert.equal(r.dir, path.resolve(root, '某文档'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('P2-9：同一文档重导复用原目录（覆盖更新）', () => {
  const root = tmpRoot();
  try {
    const dir = path.join(root, '某文档');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ docId: 'DOCIDAAA' }), 'utf8');

    const r = resolveOutDir(root, '某文档', 'DOCIDAAA');
    assert.equal(r.reused, true, '同一 docId 应复用原目录');
    assert.equal(r.dir, path.resolve(dir));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('P2-9：不同文档同名必须分目录，不得覆盖（原实现会丢数据）', () => {
  const root = tmpRoot();
  try {
    const dir = path.join(root, '某文档');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ docId: 'OTHERDOC' }), 'utf8');

    const r = resolveOutDir(root, '某文档', 'DOCIDAAA');
    assert.equal(r.reused, false);
    assert.notEqual(r.dir, path.resolve(dir), '不同文档不得落进同一目录');
    assert.match(path.basename(r.dir), /某文档 \(DOCIDAAA\)/);
    // 原目录里的旧产物必须仍在
    assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('P2-9：manifest 损坏时按不同文档处理（宁可多目录也不覆盖）', () => {
  const root = tmpRoot();
  try {
    const dir = path.join(root, '某文档');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ broken json', 'utf8');

    const r = resolveOutDir(root, '某文档', 'DOCIDAAA');
    assert.equal(r.reused, false);
    assert.match(path.basename(r.dir), /\(DOCIDAAA\)/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
