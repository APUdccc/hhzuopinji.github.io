'use strict';
// 运行：node --test test/      （需要 Node 18+，不依赖 ffmpeg / 浏览器）
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

/* ───────── 最小样本文件生成 ───────── */
const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const le16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const be16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const png = (w, h) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), be32(13), Buffer.from('IHDR'), be32(w), be32(h), Buffer.alloc(9)]);
const gif = (w, h) => Buffer.concat([Buffer.from('GIF89a'), le16(w), le16(h), Buffer.alloc(8)]);
const jpeg = (w, h) => Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]), be16(h), be16(w), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
]);
const webp = (w, h) => {
  const wb = Buffer.alloc(3); wb.writeUIntLE(w - 1, 0, 3);
  const hb = Buffer.alloc(3); hb.writeUIntLE(h - 1, 0, 3);
  return Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('VP8X'), Buffer.alloc(4), Buffer.alloc(4), wb, hb]);
};
const box = (type, payload) => Buffer.concat([be32(8 + payload.length), Buffer.from(type), payload]);
function mp4(w, h, seconds, rotate) {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(seconds * 1000, 16);
  const tkhd = Buffer.alloc(84);
  tkhd.writeInt32BE(rotate ? 0 : 0x10000, 40); tkhd.writeInt32BE(rotate ? 0x10000 : 0, 44);
  tkhd.writeUInt32BE(w * 65536, 76); tkhd.writeUInt32BE(h * 65536, 80);
  const audio = box('trak', box('tkhd', Buffer.alloc(84)));
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', Buffer.concat([box('mvhd', mvhd), audio, box('trak', box('tkhd', tkhd))])), box('mdat', Buffer.alloc(16))]);
}
const ebml = (idHex, payload) => Buffer.concat([Buffer.from(idHex, 'hex'), Buffer.from([0x80 | payload.length]), payload]);
function mkv(w, h, seconds) {
  const dur = Buffer.alloc(4); dur.writeFloatBE(seconds * 1000);
  const info = ebml('1549a966', Buffer.concat([ebml('2ad7b1', Buffer.from([0x0f, 0x42, 0x40])), ebml('4489', dur)]));
  const video = ebml('e0', Buffer.concat([ebml('b0', be16(w)), ebml('ba', be16(h))]));
  const tracks = ebml('1654ae6b', Buffer.concat([ebml('ae', ebml('e1', Buffer.alloc(1))), ebml('ae', video)]));
  const segment = Buffer.concat([Buffer.from('18538067', 'hex'), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), info, tracks]);
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]), segment]);
}

/* ───────── 服务进程 ───────── */
let portSeed = 18700 + Math.floor(Math.random() * 500);
async function startServer(env = {}) {
  const port = portSeed++;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-data-'));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), GALLERY_DATA: data, ...env }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/api/info`, { headers: env.GALLERY_TOKEN ? { cookie: `mg_token=${env.GALLERY_TOKEN}` } : {} }); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const call = async (url, opt) => {
    const r = await fetch(base + url, opt);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const post = (url, body) => call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const stop = () => { proc.kill(); fs.rmSync(data, { recursive: true, force: true }); };
  return { base, call, post, stop, port };
}

async function waitScan(srv, kind, rootId) {
  for (let i = 0; i < 100; i++) {
    const r = await srv.call(`/api/scan?kind=${kind}`);
    if (r.json[rootId] && r.json[rootId].state !== 'running' && r.json[rootId].state !== 'none') return r.json[rootId];
    await new Promise((r2) => setTimeout(r2, 50));
  }
  throw new Error('扫描超时');
}

/* ───────── 测试 ───────── */
const media = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-media-'));
const w = (rel, buf) => { const f = path.join(media, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); };
w('a/wall_1.png', png(1920, 1080));
w('a/photo.jpg', jpeg(4000, 3000));
w('a/b/anim.gif', gif(640, 360));
w('a/b/壁纸.webp', webp(2560, 1440));
w('9lives.png', png(7680, 4320));
w('tiny.png', png(100, 100));
w('movies/m1.mp4', mp4(1920, 1080, 90));
w('movies/rot.mp4', mp4(1280, 720, 100, true));
w('movies/old.mkv', mkv(854, 480, 7));
w('movies/old.zh.srt', Buffer.from('1\r\n00:00:01,000 --> 00:00:02,500\r\n你好\r\n'));
w('notes.txt', Buffer.from('not media'));

let srv, rootId;
test.before(async () => {
  srv = await startServer();
  const r = await srv.post('/api/roots', { path: media, name: '样本' });
  rootId = r.json.id;
});
test.after(() => { srv.stop(); fs.rmSync(media, { recursive: true, force: true }); });

test('添加媒体源：校验路径、拒绝重复', async () => {
  assert.equal((await srv.post('/api/roots', { path: path.join(media, 'nope') })).status, 400);
  assert.equal((await srv.post('/api/roots', { path: path.join(media, 'notes.txt') })).status, 400);
  assert.equal((await srv.post('/api/roots', { path: media })).status, 400);
  assert.ok(rootId);
});

test('图片：未手动扫描时没有任何内容；扫描后解析各格式分辨率', async () => {
  let r = await srv.call(`/api/items?kind=image&root=${rootId}&rec=1`);
  assert.equal(r.json.total, 0);
  await srv.post('/api/scan', { kind: 'image', action: 'start' });
  assert.equal((await waitScan(srv, 'image', rootId)).state, 'done');
  r = await srv.call(`/api/items?kind=image&root=${rootId}&rec=1`);
  const by = Object.fromEntries(r.json.items.map((i) => [i.n, `${i.w}x${i.h}`]));
  assert.deepEqual(by, {
    'wall_1.png': '1920x1080', 'photo.jpg': '4000x3000', 'anim.gif': '640x360', '壁纸.webp': '2560x1440',
    '9lives.png': '7680x4320', 'tiny.png': '100x100',
  });
});

test('视频：MP4（含旋转）与 MKV 的分辨率、时长', async () => {
  await srv.post('/api/scan', { kind: 'video', action: 'start' });
  await waitScan(srv, 'video', rootId);
  const r = await srv.call(`/api/items?kind=video&root=${rootId}&rec=1`);
  const by = Object.fromEntries(r.json.items.map((i) => [i.n, i]));
  assert.equal(`${by['m1.mp4'].w}x${by['m1.mp4'].h}`, '1920x1080');
  assert.equal(Math.round(by['m1.mp4'].t), 90);
  assert.equal(`${by['rot.mp4'].w}x${by['rot.mp4'].h}`, '720x1280', '旋转 90° 后宽高互换');
  assert.equal(`${by['old.mkv'].w}x${by['old.mkv'].h}`, '854x480');
  assert.equal(Math.round(by['old.mkv'].t), 7);
});

test('分辨率分类、名称分组（含中文拼音）、类型分类', async () => {
  const r = await srv.call(`/api/items?kind=image&root=${rootId}&rec=1&group=res`);
  assert.deepEqual(r.json.groups.map((g) => g.g), ['8k', '4k', '2k', '1080', 'sd']);
  assert.deepEqual(r.json.facets.types.map((t) => t.e).sort(), ['gif', 'jpg', 'png', 'webp']);
  const n = await srv.call(`/api/items?kind=image&root=${rootId}&rec=1&group=name`);
  const g = Object.fromEntries(n.json.items.map((i) => [i.n, i.g]));
  assert.equal(g['9lives.png'], '0-9');
  assert.equal(g['壁纸.webp'], 'B');
  assert.equal(g['photo.jpg'], 'P');
  assert.equal(n.json.groups[0].g, '0-9');
});

test('筛选：类型 / 分辨率 / 搜索 / 排序', async () => {
  const q = (s) => srv.call(`/api/items?kind=image&root=${rootId}&rec=1&${s}`).then((r) => r.json);
  assert.equal((await q('types=png')).total, 3);
  assert.equal((await q('res=4k,8k')).total, 2);
  assert.equal((await q('q=壁纸')).total, 1);
  assert.equal((await q('q=b%2F')).total, 2, '搜索匹配目录路径');
  assert.equal((await q('sort=size&order=desc')).items[0].n.length > 0, true);
  const byRes = await q('sort=res&order=desc');
  assert.equal(byRes.items[0].n, '9lives.png');
});

test('目录层级：子文件夹、非递归 / 递归', async () => {
  const top = await srv.call(`/api/items?kind=image&root=${rootId}`).then((r) => r.json);
  assert.deepEqual(top.items.map((i) => i.n).sort(), ['9lives.png', 'tiny.png']);
  assert.deepEqual(top.folders.map((f) => [f.name, f.total]), [['a', 4]]);
  const a = await srv.call(`/api/items?kind=image&root=${rootId}&dir=a`).then((r) => r.json);
  assert.equal(a.items.length, 2);
  assert.deepEqual(a.folders.map((f) => f.dir), ['a/b']);
  const rec = await srv.call(`/api/items?kind=image&root=${rootId}&dir=a&rec=1`).then((r) => r.json);
  assert.equal(rec.total, 4);
  const tree = await srv.call(`/api/tree?kind=image&root=${rootId}&dir=a`).then((r) => r.json);
  assert.deepEqual(tree.children.map((c) => c.dir), ['a/b']);
});

test('只扫描当前文件夹：新增文件只影响该文件夹，其它保持不变', async () => {
  w('a/b/new.png', png(3840, 2160));
  w('tiny2.png', png(10, 10)); // 不在 a/ 下，不应被扫到
  await srv.post('/api/scan', { root: rootId, dir: 'a', kind: 'image', action: 'start' });
  await waitScan(srv, 'image', rootId);
  const r = await srv.call(`/api/items?kind=image&root=${rootId}&rec=1`).then((x) => x.json);
  assert.equal(r.total, 7);
  assert.ok(r.items.some((i) => i.n === 'new.png'));
  assert.ok(!r.items.some((i) => i.n === 'tiny2.png'));
  await srv.post('/api/scan', { root: rootId, dir: 'does/not/exist', kind: 'image', action: 'start' });
  const st = await srv.call('/api/scan?kind=image').then((x) => x.json[rootId]);
  assert.equal(st.state, 'error');
  assert.equal(st.count, 7, '出错时保留原索引');
});

test('收藏夹：文件和文件夹，删除媒体源时一并清理', async () => {
  assert.equal((await srv.post('/api/fav', { k: 'f', r: rootId, p: 'a/photo.jpg' })).json.on, true);
  assert.equal((await srv.post('/api/fav', { k: 'd', r: rootId, p: 'a/b' })).json.on, true);
  const favItems = await srv.call('/api/items?scope=fav&kind=all').then((r) => r.json);
  assert.deepEqual(favItems.items.map((i) => [i.n, i.f]), [['photo.jpg', 1]]);
  const dirs = await srv.call('/api/favorites').then((r) => r.json.dirs);
  assert.equal(dirs[0].dir, 'a/b');
  assert.equal(dirs[0].images, 3);
  const only = await srv.call(`/api/items?kind=image&root=${rootId}&rec=1&favOnly=1`).then((r) => r.json);
  assert.equal(only.total, 1);
  assert.equal((await srv.post('/api/fav', { k: 'f', r: rootId, p: 'a/photo.jpg' })).json.on, false, '再次切换即取消');
});

test('继续观看：播放进度存服务端，可筛选并带进度', async () => {
  assert.equal((await srv.post('/api/pos', { r: rootId, p: 'movies/m1.mp4', s: 42 })).status, 200);
  const r = await srv.call(`/api/items?kind=video&root=${rootId}&rec=1&resume=1`).then((x) => x.json);
  assert.deepEqual(r.items.map((i) => [i.n, i.rp]), [['m1.mp4', 42]]);
  await srv.post('/api/pos', { r: rootId, p: 'movies/m1.mp4', s: 0 });
  const r2 = await srv.call(`/api/items?kind=video&root=${rootId}&rec=1&resume=1`).then((x) => x.json);
  assert.equal(r2.total, 0);
});

test('字幕：列出同名 srt 并转换为 vtt', async () => {
  const subs = await srv.call(`/api/subs?r=${rootId}&p=${encodeURIComponent('movies/old.mkv')}`).then((r) => r.json);
  assert.deepEqual(subs.map((s) => [s.label, s.path]), [['zh', 'movies/old.zh.srt']]);
  const vtt = await srv.call(`/sub/${rootId}/movies/old.zh.srt`);
  assert.equal(vtt.status, 200);
  assert.match(vtt.text, /^WEBVTT/);
  assert.match(vtt.text, /00:00:01\.000 --> 00:00:02\.500/);
});

test('文件服务：Range、路径穿越、非媒体文件', async () => {
  const r = await fetch(`${srv.base}/file/${rootId}/movies/m1.mp4`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.match(r.headers.get('content-range'), /^bytes 0-9\//);
  assert.equal((await r.arrayBuffer()).byteLength, 10);
  assert.equal((await srv.call(`/file/${rootId}/..%2F..%2Fetc%2Fpasswd`)).status, 404);
  assert.equal((await srv.call(`/file/${rootId}/notes.txt`)).status, 404, '只提供媒体类型文件');
  assert.equal((await srv.call(`/file/nope/a.png`)).status, 404);
});

test('安全：Host 校验、跨站 POST、缺少 JSON 头', async () => {
  const status = (headers, method = 'GET', body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: method === 'GET' ? '/api/info' : '/api/fav', method, headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(await status({ Host: 'evil.com' }), 403);
  assert.equal(await status({ Origin: 'http://evil.com', 'Content-Type': 'application/json' }, 'POST', '{}'), 403);
  assert.equal(await status({ 'Content-Type': 'text/plain' }, 'POST', '{}'), 403);
});

test('设置与缩略图缓存接口', async () => {
  assert.equal((await srv.post('/api/settings', { pregenThumbs: 'all' })).json.pregenThumbs, 'all');
  assert.equal((await srv.post('/api/settings', { pregenThumbs: 'bogus' })).json.pregenThumbs, 'all', '非法值被忽略');
  const t = await srv.call('/api/thumbs').then((r) => r.json);
  assert.equal(typeof t.bytes, 'number');
});

test('删除媒体源后收藏被清理', async () => {
  await srv.post('/api/fav', { k: 'f', r: rootId, p: 'a/photo.jpg' });
  const del = await srv.call(`/api/roots/${rootId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(del.status, 200);
  assert.equal((await srv.call('/api/items?scope=fav&kind=all').then((r) => r.json)).total, 0);
});

test('访问口令：未带口令 401，?token= 换取 Cookie 后放行', async () => {
  const s = await startServer({ GALLERY_TOKEN: 'sesame' });
  try {
    const base = s.base;
    assert.equal((await fetch(`${base}/api/info`)).status, 401);
    const redirect = await fetch(`${base}/?token=sesame`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    const cookie = redirect.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/info`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/?token=wrong`, { redirect: 'manual' })).status, 401);
  } finally {
    s.stop();
  }
});
