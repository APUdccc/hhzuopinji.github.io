#!/usr/bin/env node
/*
 * 本地媒体库 —— 零依赖 Node.js 服务
 *   node server.js            默认监听 http://127.0.0.1:8686
 *   PORT=9000 node server.js  自定义端口
 *   HOST=0.0.0.0 ...          允许局域网访问（注意：后台可浏览本机目录，请只在可信网络使用）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 8686;
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.GALLERY_TOKEN || ''; // 设置后，所有请求都需要口令（对局域网开放时建议设置）
const DATA_DIR = process.env.GALLERY_DATA || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const INDEX_DIR = path.join(DATA_DIR, 'index');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', 'mts', '3gp', 'ogv']);
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '@eadir', '.git']);

const MIME = {
  jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  m2ts: 'video/mp2t', mts: 'video/mp2t', '3gp': 'video/3gpp', ogv: 'video/ogg',
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

const caps = { ffmpeg: false, ffprobe: false };

/* ───────────────────────── 工具函数 ───────────────────────── */

const normExt = (e) => (['jpeg', 'jpe', 'jfif'].includes(e) ? 'jpg' : e);
const extOf = (name) => {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
};
const kindOfExt = (e) => (IMAGE_EXT.has(e) ? 'image' : VIDEO_EXT.has(e) ? 'video' : null);
const toPosix = (p) => p.split(path.sep).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

function makePool(n) {
  let active = 0;
  const waiters = [];
  return {
    async add(fn) {
      while (active >= n) await new Promise((r) => waiters.push(r));
      active++;
      fn()
        .catch(() => {})
        .finally(() => {
          active--;
          const w = waiters.shift();
          if (w) w();
        });
    },
    async idle() {
      while (active > 0) await sleep(15);
    },
  };
}

/* ───────────────────────── 配置（媒体源 / 收藏夹） ───────────────────────── */

const DEFAULT_SETTINGS = { pregenThumbs: 'video' }; // video | all | off
let config = { roots: [], favorites: [], positions: {}, settings: { ...DEFAULT_SETTINGS } };
let favSet = new Set();
let favVersion = 0;
let posVersion = 0;
const MAX_POSITIONS = 300;

const favKey = (k, r, p) => `${k}|${r}|${p}`;

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config.roots = Array.isArray(c.roots) ? c.roots : [];
    config.favorites = Array.isArray(c.favorites) ? c.favorites : [];
    config.positions = c.positions && typeof c.positions === 'object' ? c.positions : {};
    config.settings = { ...DEFAULT_SETTINGS, ...(c.settings || {}) };
  } catch {
    /* 首次运行 */
  }
  rebuildFavSet();
}

function rebuildFavSet() {
  favSet = new Set(config.favorites.map((f) => favKey(f.k, f.r, f.p)));
  favVersion++;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows 上目标文件被杀毒/索引程序短暂占用时 rename 会失败，退回直接覆盖写
    fs.writeFileSync(file, JSON.stringify(data));
    fs.rmSync(tmp, { force: true });
  }
}

const saveConfig = () => writeJsonAtomic(CONFIG_FILE, config);
let saveTimer = null;
const saveConfigSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveConfig, 800); };
const posKey = (r, p) => `${r}|${p}`;
const posOf = (r, p) => { const v = config.positions[posKey(r, p)]; return v ? v.s : 0; };
const findRoot = (id) => config.roots.find((r) => r.id === id);

function samePath(a, b) {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function resolveInRoot(root, rel) {
  if (rel.includes('\0')) return null;
  const base = path.resolve(root.path);
  const abs = path.resolve(base, rel);
  const a = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const b = process.platform === 'win32' ? base.toLowerCase() : base;
  if (a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)) return abs;
  return null;
}

/* ───────────────────────── 图片 / 视频尺寸解析 ───────────────────────── */

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

async function readImageSize(file, ext) {
  const fh = await fsp.open(file, 'r');
  try {
    const st = await fh.stat();
    const b = await readAt(fh, 0, 65536);
    if (b.length < 16) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.toString('latin1', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b[0] === 0x42 && b[1] === 0x4d) return { w: Math.abs(b.readInt32LE(18)), h: Math.abs(b.readInt32LE(22)) };
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const t = b.toString('latin1', 12, 16);
      if (t === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (t === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (t === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      return null;
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let pos = 2;
      while (pos + 4 < st.size) {
        const s = pos + 4 <= b.length ? b.subarray(pos, pos + 4) : await readAt(fh, pos, 4);
        if (s[0] !== 0xff) { pos++; continue; }
        const mk = s[1];
        if (mk === 0xff) { pos++; continue; }
        if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { pos += 2; continue; }
        const len = s.readUInt16BE(2);
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
          const f = await readAt(fh, pos + 4, 5);
          return { h: f.readUInt16BE(1), w: f.readUInt16BE(3) };
        }
        pos += 2 + len;
      }
      return null;
    }
    if (ext === 'svg') {
      const head = b.toString('utf8', 0, 4096);
      const tag = head.match(/<svg[^>]*>/i);
      if (!tag) return null;
      const num = (n) => {
        const m = tag[0].match(new RegExp(`\\s${n}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, 'i'));
        return m ? Math.round(parseFloat(m[1])) : 0;
      };
      let w = num('width'), h = num('height');
      if (!w || !h) {
        const vb = tag[0].match(/viewBox\s*=\s*["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
        if (vb) { w = Math.round(parseFloat(vb[1])); h = Math.round(parseFloat(vb[2])); }
      }
      return w && h ? { w, h } : null;
    }
    if (ext === 'avif') {
      const i = b.indexOf('ispe');
      if (i > 0 && i + 16 <= b.length) return { w: b.readUInt32BE(i + 8), h: b.readUInt32BE(i + 12) };
    }
    return null;
  } finally {
    await fh.close();
  }
}

function parseMoov(buf) {
  const boxes = (start, end) => {
    const out = [];
    let pos = start;
    while (pos + 8 <= end) {
      let sz = buf.readUInt32BE(pos);
      const type = buf.toString('latin1', pos + 4, pos + 8);
      let hdr = 8;
      if (sz === 1) { sz = Number(buf.readBigUInt64BE(pos + 8)); hdr = 16; }
      else if (sz === 0) sz = end - pos;
      if (sz < hdr || pos + sz > end) break;
      out.push({ type, s: pos + hdr, e: pos + sz });
      pos += sz;
    }
    return out;
  };
  const res = { w: 0, h: 0, t: 0 };
  for (const bx of boxes(0, buf.length)) {
    if (bx.type === 'mvhd') {
      const v = buf[bx.s];
      const scale = v === 1 ? buf.readUInt32BE(bx.s + 20) : buf.readUInt32BE(bx.s + 12);
      const dur = v === 1 ? Number(buf.readBigUInt64BE(bx.s + 24)) : buf.readUInt32BE(bx.s + 16);
      if (scale) res.t = dur / scale;
    } else if (bx.type === 'trak') {
      for (const sub of boxes(bx.s, bx.e)) {
        if (sub.type !== 'tkhd') continue;
        const v = buf[sub.s];
        const mOff = sub.s + (v === 1 ? 52 : 40);
        const wOff = sub.s + (v === 1 ? 88 : 76);
        if (wOff + 8 > sub.e) continue;
        let w = buf.readUInt32BE(wOff) / 65536;
        let h = buf.readUInt32BE(wOff + 4) / 65536;
        if (!(w > 0 && h > 0)) continue;
        if (buf.readInt32BE(mOff) === 0 && buf.readInt32BE(mOff + 4) !== 0) [w, h] = [h, w];
        if (w * h > res.w * res.h) { res.w = Math.round(w); res.h = Math.round(h); }
      }
    }
  }
  return res.w ? res : null;
}

async function readMp4Info(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    let pos = 0;
    while (pos + 8 <= size) {
      const h = await readAt(fh, pos, 16);
      if (h.length < 8) break;
      let sz = h.readUInt32BE(0);
      const type = h.toString('latin1', 4, 8);
      let hdr = 8;
      if (sz === 1 && h.length >= 16) { sz = Number(h.readBigUInt64BE(8)); hdr = 16; }
      else if (sz === 0) sz = size - pos;
      if (sz < hdr) break;
      if (type === 'moov') {
        if (sz > 96 * 1024 * 1024) return null;
        return parseMoov(await readAt(fh, pos + hdr, sz - hdr));
      }
      pos += sz;
    }
    return null;
  } finally {
    await fh.close();
  }
}

/* MKV / WebM（EBML）：只读文件头部，取视频轨像素尺寸和时长 */
function parseEbml(buf) {
  const MASTER = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0]); // Segment Info Tracks TrackEntry Video
  const res = { w: 0, h: 0, t: 0 };
  let scale = 1e6, dur = 0;
  const readId = (p) => {
    const b = buf[p];
    if (b === undefined) return null;
    let len = 1, mask = 0x80;
    while (len <= 4 && !(b & mask)) { len++; mask >>= 1; }
    if (len > 4 || p + len > buf.length) return null;
    let id = 0;
    for (let i = 0; i < len; i++) id = id * 256 + buf[p + i];
    return { id, len };
  };
  const readSize = (p) => {
    const b = buf[p];
    if (b === undefined) return null;
    let len = 1, mask = 0x80;
    while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
    if (len > 8 || p + len > buf.length) return null;
    let v = b & (mask - 1);
    let unknown = v === mask - 1;
    for (let i = 1; i < len; i++) {
      v = v * 256 + buf[p + i];
      if (buf[p + i] !== 0xff) unknown = false;
    }
    return { size: unknown ? -1 : v, len };
  };
  const uint = (s, e) => { let v = 0; for (let i = s; i < e && i < s + 8; i++) v = v * 256 + buf[i]; return v; };
  let pw = 0, ph = 0;
  const walk = (start, end) => {
    let p = start;
    while (p < end) {
      const id = readId(p);
      if (!id) return false;
      const sz = readSize(p + id.len);
      if (!sz) return false;
      const ds = p + id.len + sz.len;
      const de = sz.size < 0 ? end : Math.min(ds + sz.size, Number.MAX_SAFE_INTEGER);
      if (id.id === 0x1f43b675) return true; // Cluster：头部信息已读完
      if (MASTER.has(id.id)) {
        if (id.id === 0xe0) { pw = 0; ph = 0; }
        if (walk(ds, Math.min(de, end))) return true;
        if (id.id === 0xe0 && pw * ph > res.w * res.h) { res.w = pw; res.h = ph; }
      } else if (id.id === 0xb0 && de <= end) pw = uint(ds, de);
      else if (id.id === 0xba && de <= end) ph = uint(ds, de);
      else if (id.id === 0x2ad7b1 && de <= end) scale = uint(ds, de) || scale;
      else if (id.id === 0x4489 && de <= end) {
        if (de - ds === 4) dur = buf.readFloatBE(ds);
        else if (de - ds === 8) dur = buf.readDoubleBE(ds);
      }
      if (de >= end) return false;
      p = de;
    }
    return false;
  };
  walk(0, buf.length);
  if (dur) res.t = (dur * scale) / 1e9;
  return res.w ? res : null;
}

async function readEbmlInfo(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const b = await readAt(fh, 0, 1024 * 1024);
    return b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3 ? parseEbml(b) : null;
  } finally {
    await fh.close();
  }
}

async function ffprobeInfo(file) {
  const out = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration',
    '-of', 'json', file,
  ]);
  if (!out) return null;
  try {
    const j = JSON.parse(out);
    const s = (j.streams || [])[0];
    if (!s || !s.width) return null;
    let { width: w, height: h } = s;
    const rot = Math.abs(Number(((s.side_data_list || []).find((d) => d.rotation !== undefined) || {}).rotation || 0));
    if (rot === 90 || rot === 270) [w, h] = [h, w];
    return { w, h, t: Number((j.format || {}).duration) || 0 };
  } catch {
    return null;
  }
}

async function probe(file, kind, ext) {
  let r = null;
  if (kind === 'image') {
    r = await readImageSize(file, ext).catch(() => null);
    if (!r && caps.ffprobe && ext !== 'svg') r = await ffprobeInfo(file);
  } else {
    if (['mp4', 'm4v', 'mov', '3gp'].includes(ext)) r = await readMp4Info(file).catch(() => null);
    else if (ext === 'mkv' || ext === 'webm') r = await readEbmlInfo(file).catch(() => null);
    if ((!r || !r.w) && caps.ffprobe) r = (await ffprobeInfo(file)) || r;
  }
  return r;
}

/* ───────────────────────── 索引 / 扫描 ───────────────────────── */

const indexes = new Map(); // `${root}|${kind}` -> Index

function indexFile(rootId, kind) {
  return path.join(INDEX_DIR, `${rootId}-${kind}.json`);
}

function mkItem(p, s, m, extra) {
  const i = p.lastIndexOf('/');
  const n = p.slice(i + 1);
  return { p, n, d: i < 0 ? '' : p.slice(0, i), e: normExt(extOf(n)), s, m, w: 0, h: 0, t: 0, ...extra };
}

function getIndex(rootId, kind) {
  const key = `${rootId}|${kind}`;
  let idx = indexes.get(key);
  if (idx) return idx;
  idx = { items: [], map: new Map(), version: 1, tree: null, treeV: 0, scan: { state: 'none' } };
  try {
    const j = JSON.parse(fs.readFileSync(indexFile(rootId, kind), 'utf8'));
    for (const r of j.items) {
      const it = mkItem(r[0], r[1], r[2], { w: r[3] || 0, h: r[4] || 0, t: r[5] || 0 });
      idx.items.push(it);
      idx.map.set(it.p, it);
    }
    idx.scan = { state: 'done', updatedAt: j.updatedAt || 0, found: idx.items.length };
  } catch {
    /* 尚未扫描 */
  }
  indexes.set(key, idx);
  return idx;
}

function persistIndex(rootId, kind, idx) {
  try {
    writeJsonAtomic(indexFile(rootId, kind), {
      updatedAt: idx.scan.updatedAt,
      items: idx.items.map((i) => [i.p, i.s, i.m, i.w, i.h, Math.round(i.t * 10) / 10]),
    });
  } catch (e) {
    console.error('保存索引失败:', e.message);
  }
}

async function runScan(rootId, kind, dir = '') {
  const root = findRoot(rootId);
  const idx = getIndex(rootId, kind);
  if (!root || idx.scan.state === 'running') return;
  const base = path.resolve(root.path);
  if (!fs.existsSync(base)) {
    idx.scan = { state: 'error', error: '路径不存在或无法访问', updatedAt: Date.now() };
    return;
  }
  dir = dir.replace(/^\/+|\/+$/g, '');
  const startAbs = resolveInRoot(root, dir);
  if (!startAbs || !fs.existsSync(startAbs)) {
    idx.scan = { state: 'error', error: '要扫描的文件夹不存在', updatedAt: Date.now() };
    return;
  }

  const exts = kind === 'image' ? IMAGE_EXT : VIDEO_EXT;
  const prev = idx.map;
  // 整库首次扫描：边扫边显示；重新扫描 / 只扫某个文件夹：完成后一次性替换
  const live = !dir && idx.items.length === 0;
  const prefix = dir ? `${dir}/` : '';
  const items = dir ? idx.items.filter((it) => !(it.d === dir || it.d.startsWith(prefix))) : [];
  const map = new Map(items.map((it) => [it.p, it]));
  const sc = { state: 'running', dirs: 0, found: 0, probed: 0, errors: 0, startedAt: Date.now(), cancel: false };
  idx.scan = sc;
  if (live) { idx.items = items; idx.map = map; }

  const pool = makePool(kind === 'image' ? 12 : 4);
  const stack = [dir];
  const tick = setInterval(() => { if (live) { idx.version++; } }, 400);

  const handleFile = async (rel) => {
    if (sc.cancel) return;
    const abs = path.join(base, rel);
    let st;
    try { st = await fsp.stat(abs); } catch { sc.errors++; return; }
    if (!st.isFile()) return;
    const old = prev.get(rel);
    const reuse = old && old.s === st.size && old.m === Math.floor(st.mtimeMs) && old.w;
    const it = mkItem(rel, st.size, Math.floor(st.mtimeMs), reuse ? { w: old.w, h: old.h, t: old.t } : {});
    items.push(it);
    map.set(rel, it);
    sc.found++;
    if (!reuse) {
      const r = await probe(abs, kind, it.e);
      if (r) { it.w = r.w || 0; it.h = r.h || 0; it.t = r.t || 0; }
    }
    sc.probed++;
  };

  try {
    while (stack.length && !sc.cancel) {
      const rel = stack.pop();
      let ents;
      try { ents = await fsp.readdir(path.join(base, rel), { withFileTypes: true }); } catch { sc.errors++; continue; }
      sc.dirs++;
      for (const ent of ents) {
        const name = ent.name;
        const childRel = rel ? `${rel}/${name}` : name;
        if (ent.isDirectory()) {
          if (name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase())) continue;
          stack.push(childRel);
        } else if (ent.isFile() || ent.isSymbolicLink()) {
          const e = extOf(name);
          if (!exts.has(e) || name.startsWith('._')) continue;
          await pool.add(() => handleFile(childRel));
        }
      }
    }
    await pool.idle();
    if (sc.cancel) {
      sc.state = 'cancelled';
    } else {
      sc.state = 'done';
      if (!live) { idx.items = items; idx.map = map; }
    }
    sc.updatedAt = Date.now();
    sc.found = idx.items.length;
    if (live || sc.state === 'done') persistIndex(rootId, kind, idx);
  } catch (e) {
    sc.state = 'error';
    sc.error = e.message;
  } finally {
    clearInterval(tick);
    idx.version++;
  }
  if (sc.state === 'done') pregenThumbs(rootId, kind).catch(() => {});
}

function scanStatus(rootId, kind) {
  const idx = getIndex(rootId, kind);
  const s = idx.scan;
  return {
    state: s.state, count: idx.items.length, dirs: s.dirs || 0, found: s.found || 0, probed: s.probed || 0,
    errors: s.errors || 0, updatedAt: s.updatedAt || 0, startedAt: s.startedAt || 0, error: s.error || '',
  };
}

/* ───────────────────────── 目录树 ───────────────────────── */

function getTree(idx) {
  if (idx.tree && idx.treeV === idx.version) return idx.tree;
  const nodes = new Map();
  const node = (d) => {
    let n = nodes.get(d);
    if (!n) { n = { total: 0, kids: new Set() }; nodes.set(d, n); }
    return n;
  };
  for (const it of idx.items) {
    let cur = it.d;
    for (;;) {
      node(cur).total++;
      if (cur === '') break;
      const i = cur.lastIndexOf('/');
      const parent = i < 0 ? '' : cur.slice(0, i);
      node(parent).kids.add(cur);
      cur = parent;
    }
  }
  idx.tree = nodes;
  idx.treeV = idx.version;
  return nodes;
}

function treeChildren(rootId, kind, dir) {
  const nodes = getTree(getIndex(rootId, kind));
  const n = nodes.get(dir);
  if (!n) return [];
  return [...n.kids]
    .map((k) => {
      const kn = nodes.get(k);
      return { dir: k, name: k.slice(k.lastIndexOf('/') + 1), total: kn.total, hasKids: kn.kids.size > 0 };
    })
    .sort((a, b) => collator.compare(a.name, b.name));
}

/* ───────────────────────── 查询：过滤 / 分类 / 排序 ───────────────────────── */

const RES_ORDER = ['8k', '4k', '2k', '1080', '720', '480', 'sd', 'unk'];

function resBucket(it) {
  if (!it.w || !it.h) return 'unk';
  const s = Math.min(it.w, it.h);
  if (s >= 4320) return '8k';
  if (s >= 2160) return '4k';
  if (s >= 1440) return '2k';
  if (s >= 1080) return '1080';
  if (s >= 720) return '720';
  if (s >= 480) return '480';
  return 'sd';
}

const PINYIN_BOUNDS = '阿八嚓哒妸发旮哈讥咔垃痳拏噢妑七呥扨它穵夕丫帀'.split('');
const PINYIN_LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ';
const zhCollator = new Intl.Collator('zh-CN');

function nameGroup(name) {
  const ch = name.charAt(0);
  if (/[a-z]/i.test(ch)) return ch.toUpperCase();
  if (/\d/.test(ch)) return '0-9';
  if (/[一-鿿]/.test(ch)) {
    let r = 0;
    for (let i = 0; i < PINYIN_BOUNDS.length; i++) {
      if (zhCollator.compare(PINYIN_BOUNDS[i], ch) <= 0) r = i; else break;
    }
    return PINYIN_LETTERS[r];
  }
  return '#';
}

const nameGroupRank = (g) => (g === '0-9' ? 0 : g === '#' ? 99 : g.charCodeAt(0) - 64);

function resolveFavFiles(kind) {
  const out = [];
  for (const f of config.favorites) {
    if (f.k !== 'f') continue;
    const root = findRoot(f.r);
    if (!root) continue;
    const k = kindOfExt(extOf(f.p));
    if (!k || (kind !== 'all' && k !== kind)) continue;
    let it = getIndex(f.r, k).map.get(f.p);
    if (!it) {
      const abs = resolveInRoot(root, f.p);
      let st;
      try { st = abs && fs.statSync(abs); } catch { st = null; }
      if (!st || !st.isFile()) continue;
      it = mkItem(f.p, st.size, Math.floor(st.mtimeMs));
    }
    out.push({ r: f.r, it, k });
  }
  return out;
}

const queryCache = new Map();

function runQuery(p) {
  const verParts = [favVersion, config.roots.length];
  if (p.scope !== 'fav') {
    for (const r of p.root ? [p.root] : config.roots.map((x) => x.id)) verParts.push(getIndex(r, p.kind).version);
  }
  const key = JSON.stringify([p.scope, p.kind, p.root, p.dir, p.rec, p.q, p.types, p.res, p.sort, p.order, p.group, p.favOnly, p.resume, posVersion, verParts]);
  const hit = queryCache.get(key);
  if (hit) return hit;

  let refs = [];
  if (p.scope === 'fav') {
    refs = resolveFavFiles(p.kind);
  } else {
    const rootIds = p.root ? [p.root] : config.roots.map((r) => r.id);
    const rec = p.rec || !p.root;
    const dir = p.root ? p.dir : '';
    const prefix = dir ? `${dir}/` : '';
    for (const rid of rootIds) {
      if (!findRoot(rid)) continue;
      for (const it of getIndex(rid, p.kind).items) {
        if (dir === '' ? (rec || it.d === '') : (it.d === dir || (rec && it.d.startsWith(prefix)))) refs.push({ r: rid, it, k: p.kind });
      }
    }
  }

  const tokens = p.q ? p.q.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const typeSet = p.types.length ? new Set(p.types) : null;
  const resSet = p.res.length ? new Set(p.res) : null;
  const typeCount = new Map();
  const resCount = new Map();
  const matched = [];
  for (const ref of refs) {
    const it = ref.it;
    if (tokens.length) {
      const hay = it.p.toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) continue;
    }
    if (p.favOnly && !favSet.has(favKey('f', ref.r, it.p))) continue;
    if (p.resume && !posOf(ref.r, it.p)) continue;
    const b = resBucket(it);
    const okT = !typeSet || typeSet.has(it.e);
    const okR = !resSet || resSet.has(b);
    if (okR) typeCount.set(it.e, (typeCount.get(it.e) || 0) + 1);
    if (okT) resCount.set(b, (resCount.get(b) || 0) + 1);
    if (okT && okR) { ref.b = b; matched.push(ref); }
  }

  const multiRoot = config.roots.length > 1;
  const rootName = (id) => (findRoot(id) || {}).name || id;
  const groupOf = (ref) => {
    switch (p.group) {
      case 'name': return nameGroup(ref.it.n);
      case 'type': return ref.it.e.toUpperCase();
      case 'res': return ref.b;
      case 'dir': return (multiRoot ? `${rootName(ref.r)} / ` : '') + (ref.it.d || '（根目录）');
      default: return '';
    }
  };
  const dirSign = p.order === 'desc' ? -1 : 1;
  const sortCmp = (a, b) => {
    let c = 0;
    switch (p.sort) {
      case 'size': c = a.it.s - b.it.s; break;
      case 'mtime': c = a.it.m - b.it.m; break;
      case 'res': c = a.it.w * a.it.h - b.it.w * b.it.h; break;
      case 'type': c = collator.compare(a.it.e, b.it.e); break;
      default: c = 0;
    }
    if (c === 0) c = collator.compare(a.it.n, b.it.n) || collator.compare(a.it.p, b.it.p);
    return c * dirSign;
  };
  for (const ref of matched) ref.g = groupOf(ref);
  let groupCmp = null;
  if (p.group === 'name') groupCmp = (a, b) => (nameGroupRank(a.g) - nameGroupRank(b.g)) * dirSign;
  else if (p.group === 'res') groupCmp = (a, b) => RES_ORDER.indexOf(a.g) - RES_ORDER.indexOf(b.g);
  else if (p.group === 'type' || p.group === 'dir') groupCmp = (a, b) => collator.compare(a.g, b.g);
  const recentCmp = (a, b) => (config.positions[posKey(b.r, b.it.p)] || { t: 0 }).t - (config.positions[posKey(a.r, a.it.p)] || { t: 0 }).t;
  if (p.resume) matched.sort(recentCmp);
  else matched.sort(groupCmp ? (a, b) => groupCmp(a, b) || sortCmp(a, b) : sortCmp);

  const groups = [];
  if (p.group !== 'none') {
    for (const ref of matched) {
      const last = groups[groups.length - 1];
      if (last && last.g === ref.g) last.count++; else groups.push({ g: ref.g, count: 1 });
    }
  }
  const facets = {
    types: [...typeCount].map(([e, count]) => ({ e, count })).sort((a, b) => b.count - a.count || a.e.localeCompare(b.e)),
    res: [...resCount].map(([b, count]) => ({ b, count })).sort((a, b) => RES_ORDER.indexOf(a.b) - RES_ORDER.indexOf(b.b)),
  };
  const result = { list: matched, groups, facets };
  queryCache.set(key, result);
  if (queryCache.size > 10) queryCache.delete(queryCache.keys().next().value);
  return result;
}

function parseQuery(sp) {
  const list = (k) => (sp.get(k) || '').split(',').filter(Boolean);
  const kind = sp.get('kind');
  return {
    scope: sp.get('scope') === 'fav' ? 'fav' : 'lib',
    kind: kind === 'image' || kind === 'video' ? kind : 'all',
    root: sp.get('root') || '',
    dir: (sp.get('dir') || '').replace(/^\/+|\/+$/g, ''),
    rec: sp.get('rec') === '1',
    q: (sp.get('q') || '').trim(),
    types: list('types'),
    res: list('res'),
    sort: ['name', 'size', 'mtime', 'res', 'type'].includes(sp.get('sort')) ? sp.get('sort') : 'name',
    order: sp.get('order') === 'desc' ? 'desc' : 'asc',
    group: ['name', 'type', 'res', 'dir'].includes(sp.get('group')) ? sp.get('group') : 'none',
    favOnly: sp.get('favOnly') === '1',
    resume: sp.get('resume') === '1',
    offset: Math.max(0, parseInt(sp.get('offset'), 10) || 0),
    limit: Math.min(1000, Math.max(1, parseInt(sp.get('limit'), 10) || 200)),
  };
}

function handleItems(sp) {
  const p = parseQuery(sp);
  if (p.scope === 'lib' && p.kind === 'all') p.kind = 'video';
  const { list, groups, facets } = runQuery(p);
  const page = list.slice(p.offset, p.offset + p.limit).map((ref) => ({
    r: ref.r, k: ref.k, p: ref.it.p, n: ref.it.n, d: ref.it.d, e: ref.it.e, s: ref.it.s, m: ref.it.m,
    w: ref.it.w, h: ref.it.h, t: ref.it.t, b: ref.b || resBucket(ref.it), g: ref.g,
    f: favSet.has(favKey('f', ref.r, ref.it.p)) ? 1 : 0, rp: posOf(ref.r, ref.it.p),
  }));
  const out = { total: list.length, offset: p.offset, items: page };
  if (p.offset === 0) {
    out.facets = facets;
    out.groups = groups;
    out.folders = [];
    if (p.scope === 'lib' && p.root && !p.rec && !p.q && !p.favOnly && !p.resume) {
      out.folders = treeChildren(p.root, p.kind, p.dir).map((c) => ({
        r: p.root, dir: c.dir, name: c.name, total: c.total, f: favSet.has(favKey('d', p.root, c.dir)) ? 1 : 0,
      }));
    }
  }
  return out;
}

function favDirs() {
  const out = [];
  for (const f of config.favorites) {
    if (f.k !== 'd') continue;
    const root = findRoot(f.r);
    if (!root) continue;
    out.push({
      r: f.r, rootName: root.name, dir: f.p,
      name: f.p ? f.p.slice(f.p.lastIndexOf('/') + 1) : root.name,
      videos: countIn(f.r, 'video', f.p), images: countIn(f.r, 'image', f.p),
    });
  }
  return out;
}

function countIn(rootId, kind, dir) {
  const n = getTree(getIndex(rootId, kind)).get(dir);
  return n ? n.total : 0;
}

/* ───────────────────────── 文件浏览（后台选择目录） ───────────────────────── */

async function listPlaces() {
  const places = [];
  const home = os.homedir();
  places.push({ name: '主目录', path: home });
  for (const n of ['Desktop', 'Downloads', 'Videos', 'Movies', 'Pictures', 'Documents']) {
    const pth = path.join(home, n);
    if (fs.existsSync(pth)) places.push({ name: n, path: pth });
  }
  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
    const ok = await Promise.all(letters.map((l) => fsp.access(`${l}:\\`).then(() => true, () => false)));
    letters.forEach((l, i) => { if (ok[i]) places.push({ name: `${l}: 盘`, path: `${l}:\\` }); });
  } else {
    places.push({ name: '根目录 /', path: '/' });
    for (const m of ['/mnt', '/media', '/Volumes']) if (fs.existsSync(m)) places.push({ name: m, path: m });
  }
  return places;
}

async function browse(p) {
  const places = await listPlaces();
  if (!p) return { path: '', parent: null, entries: [], places };
  const abs = path.resolve(p);
  const ents = await fsp.readdir(abs, { withFileTypes: true });
  const entries = [];
  for (const e of ents) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) isDir = await fsp.stat(path.join(abs, e.name)).then((s) => s.isDirectory(), () => false);
    if (isDir) entries.push({ name: e.name, path: path.join(abs, e.name) });
  }
  entries.sort((a, b) => collator.compare(a.name, b.name));
  const up = path.dirname(abs);
  return { path: abs, parent: up === abs ? '' : up, entries, places };
}

/* ───────────────────────── 外挂字幕（同名 .srt / .vtt） ───────────────────────── */

function listSubs(root, rel) {
  const abs = resolveInRoot(root, rel);
  if (!abs) return [];
  const dir = path.dirname(abs);
  const stem = path.basename(abs, path.extname(abs));
  const relDir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => /\.(srt|vtt)$/i.test(n) && n.startsWith(`${stem}.`))
    .map((n) => {
      const mid = n.slice(stem.length + 1, n.lastIndexOf('.'));
      return { label: mid || '字幕', lang: mid.slice(0, 8) || 'zh', path: relDir ? `${relDir}/${n}` : n };
    });
}

function readSubAsVtt(abs) {
  const raw = fs.readFileSync(abs);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { text = new TextDecoder('gbk').decode(raw); }
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (/^WEBVTT/.test(text)) return text;
  return `WEBVTT\n\n${text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
}

/* ───────────────────────── 缩略图 / 转码（需要 ffmpeg，可选） ───────────────────────── */

const thumbPool = makePool(3);
const thumbJobs = new Map();

function ffmpegThumb(src, out, kind, w, dur) {
  return new Promise((resolve) => {
    const args = ['-y', '-v', 'error'];
    if (kind === 'video') args.push('-ss', String(dur > 20 ? Math.min(30, dur * 0.1) : dur > 2 ? 1 : 0));
    args.push('-i', src, '-frames:v', '1', '-vf', `scale='min(${w},iw)':-2`, '-q:v', '5', out);
    const pr = spawn('ffmpeg', args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => pr.kill('SIGKILL'), 30000);
    pr.on('error', () => { clearTimeout(timer); resolve(false); });
    pr.on('close', (code) => { clearTimeout(timer); resolve(code === 0 && fs.existsSync(out)); });
  });
}

async function getThumb(root, rel, w, direct) {
  const abs = resolveInRoot(root, rel);
  const kind = kindOfExt(extOf(rel));
  if (!abs || !kind) return null;
  const st = await fsp.stat(abs);
  const key = crypto.createHash('md5').update(`${root.id}|${rel}|${st.size}|${st.mtimeMs}|${w}`).digest('hex');
  const out = path.join(THUMB_DIR, `${key}.jpg`);
  if (fs.existsSync(out)) return out;
  if (thumbJobs.has(out)) return thumbJobs.get(out);
  const work = async (resolve) => {
    try {
      fs.mkdirSync(THUMB_DIR, { recursive: true });
      const item = getIndex(root.id, kind).map.get(rel);
      let ok = await ffmpegThumb(abs, out, kind, w, item ? item.t : 0);
      if (!ok && kind === 'video') ok = await ffmpegThumb(abs, out, kind, w, 0);
      resolve(ok ? out : null);
    } catch {
      resolve(null);
    }
  };
  const job = new Promise((resolve) => {
    if (direct) work(resolve); else thumbPool.add(() => work(resolve));
  }).finally(() => thumbJobs.delete(out));
  thumbJobs.set(out, job);
  return job;
}

/* 扫描完成后在后台低优先级预生成缩略图（单线程，不抢交互请求） */
const pregenPool = makePool(1);
let pregenToken = 0;
async function pregenThumbs(rootId, kind) {
  const mode = config.settings.pregenThumbs;
  if (!caps.ffmpeg || mode === 'off' || (mode === 'video' && kind !== 'video')) return;
  const root = findRoot(rootId);
  if (!root) return;
  const my = ++pregenToken;
  for (const it of getIndex(rootId, kind).items.slice()) {
    if (my !== pregenToken || !findRoot(rootId)) return;
    await pregenPool.add(() => getThumb(root, it.p, 480, true).catch(() => {}));
  }
}

async function thumbStats() {
  let count = 0, bytes = 0;
  try {
    for (const f of await fsp.readdir(THUMB_DIR)) {
      try { bytes += (await fsp.stat(path.join(THUMB_DIR, f))).size; count++; } catch { /* 忽略 */ }
    }
  } catch { /* 目录还不存在 */ }
  return { count, bytes };
}

/* ───────────────────────── HTTP ───────────────────────── */

function send(res, code, body, headers) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : MIME.json,
    'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers,
  });
  res.end(buf);
}

function serveFile(req, res, abs, mime, cache) {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const headers = {
      'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': cache || 'no-cache',
    };
    let start = 0, end = st.size - 1, code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(end, parseInt(m[2], 10)); }
      else { start = Math.max(0, st.size - parseInt(m[2], 10)); }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      code = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(code, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(abs, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

class HttpError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

function hostAllowed(req) {
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') return true;
  const h = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest();
function tokenOk(t) {
  return typeof t === 'string' && crypto.timingSafeEqual(tokenHash(t), tokenHash(TOKEN));
}

/* 返回 true 表示放行；否则已经写好响应（401 或带 Cookie 的跳转） */
function authorize(req, res, u) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* 忽略 */ } }
  }
  if (tokenOk(cookies.mg_token)) return true;
  if (tokenOk(u.searchParams.get('token'))) {
    u.searchParams.delete('token');
    res.writeHead(302, {
      'Set-Cookie': `mg_token=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
      Location: u.pathname + u.search,
    });
    res.end();
    return false;
  }
  send(res, 401, '需要访问口令：请用 http://<地址>:<端口>/?token=<口令> 打开一次');
  return false;
}

function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

function rootSummary(r) {
  return {
    id: r.id, name: r.name, path: r.path, exists: fs.existsSync(r.path),
    scans: { image: scanStatus(r.id, 'image'), video: scanStatus(r.id, 'video') },
  };
}

async function api(req, res, u) {
  const route = u.pathname.slice(5).replace(/\/+$/, '');
  const sp = u.searchParams;
  const method = req.method;

  if (method !== 'GET' && method !== 'HEAD') {
    if (!originAllowed(req) || !/application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(403, '请求被拒绝');
  }
  const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(req);

  if (route === 'info' && method === 'GET') {
    return send(res, 200, { version: 1, caps, platform: process.platform, dataDir: DATA_DIR, port: PORT, host: HOST });
  }

  if (route === 'roots') {
    if (method === 'GET') return send(res, 200, config.roots.map(rootSummary));
    if (method === 'POST') {
      let p = String(body.path || '').trim().replace(/^["']|["']$/g, '');
      if (!p) throw new HttpError(400, '请输入文件夹路径');
      if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
      const abs = path.resolve(p);
      let st;
      try { st = await fsp.stat(abs); } catch { throw new HttpError(400, '路径不存在或无法访问'); }
      if (!st.isDirectory()) throw new HttpError(400, '这不是一个文件夹');
      if (config.roots.some((r) => samePath(path.resolve(r.path), abs))) throw new HttpError(400, '该路径已经添加过了');
      const root = {
        id: crypto.randomBytes(4).toString('hex'),
        name: String(body.name || '').trim() || path.basename(abs) || abs,
        path: abs,
      };
      config.roots.push(root);
      saveConfig();
      return send(res, 200, rootSummary(root));
    }
  }

  let m = /^roots\/([0-9a-f]+)$/.exec(route);
  if (m) {
    const root = findRoot(m[1]);
    if (!root) throw new HttpError(404, '媒体源不存在');
    if (method === 'PATCH') {
      const name = String(body.name || '').trim();
      if (!name) throw new HttpError(400, '名称不能为空');
      root.name = name;
      saveConfig();
      queryCache.clear();
      return send(res, 200, rootSummary(root));
    }
    if (method === 'DELETE') {
      config.roots = config.roots.filter((r) => r.id !== root.id);
      config.favorites = config.favorites.filter((f) => f.r !== root.id);
      rebuildFavSet();
      saveConfig();
      for (const kind of ['image', 'video']) {
        const idx = indexes.get(`${root.id}|${kind}`);
        if (idx) idx.scan.cancel = true;
        indexes.delete(`${root.id}|${kind}`);
        fs.rm(indexFile(root.id, kind), { force: true }, () => {});
      }
      queryCache.clear();
      return send(res, 200, { ok: true });
    }
  }

  if (route === 'browse' && method === 'GET') {
    try { return send(res, 200, await browse(sp.get('path') || '')); }
    catch { throw new HttpError(400, '无法读取该目录'); }
  }

  if (route === 'scan') {
    if (method === 'GET') {
      const kind = sp.get('kind') === 'image' ? 'image' : 'video';
      const out = {};
      for (const r of config.roots) out[r.id] = scanStatus(r.id, kind);
      return send(res, 200, out);
    }
    if (method === 'POST') {
      const kind = body.kind === 'image' ? 'image' : 'video';
      const ids = body.root ? [body.root] : config.roots.map((r) => r.id);
      for (const id of ids) {
        if (!findRoot(id)) continue;
        if (body.action === 'cancel') {
          const idx = getIndex(id, kind);
          if (idx.scan.state === 'running') idx.scan.cancel = true;
        } else {
          runScan(id, kind, body.root ? String(body.dir || '') : '').catch((e) => console.error('扫描失败:', e));
        }
      }
      return send(res, 200, { ok: true });
    }
  }

  if (route === 'tree' && method === 'GET') {
    const kind = sp.get('kind') === 'image' ? 'image' : 'video';
    const root = sp.get('root') || '';
    if (!findRoot(root)) throw new HttpError(404, '媒体源不存在');
    return send(res, 200, { total: countIn(root, kind, ''), children: treeChildren(root, kind, (sp.get('dir') || '').replace(/^\/+|\/+$/g, '')) });
  }

  if (route === 'items' && method === 'GET') return send(res, 200, handleItems(sp));

  if (route === 'pos' && method === 'POST') {
    const root = findRoot(String(body.r || ''));
    const p = String(body.p || '');
    if (!root || !p) throw new HttpError(400, '参数错误');
    const key = posKey(root.id, p);
    const sec = Math.floor(Number(body.s) || 0);
    if (sec > 0) {
      delete config.positions[key];
      config.positions[key] = { s: sec, t: Date.now() };
      const keys = Object.keys(config.positions);
      if (keys.length > MAX_POSITIONS) for (const k of keys.slice(0, keys.length - MAX_POSITIONS)) delete config.positions[k];
    } else delete config.positions[key];
    posVersion++;
    saveConfigSoon();
    return send(res, 200, { ok: true });
  }

  if (route === 'subs' && method === 'GET') {
    const root = findRoot(sp.get('r') || '');
    if (!root) throw new HttpError(404, '媒体源不存在');
    return send(res, 200, listSubs(root, sp.get('p') || ''));
  }

  if (route === 'settings') {
    if (method === 'POST') {
      if (['video', 'all', 'off'].includes(body.pregenThumbs)) config.settings.pregenThumbs = body.pregenThumbs;
      saveConfig();
    }
    return send(res, 200, config.settings);
  }

  if (route === 'thumbs') {
    if (method === 'POST' && body.action === 'clear') {
      pregenToken++;
      await fsp.rm(THUMB_DIR, { recursive: true, force: true });
    }
    return send(res, 200, await thumbStats());
  }

  if (route === 'favorites' && method === 'GET') return send(res, 200, { dirs: favDirs() });

  if (route === 'fav' && method === 'POST') {
    const k = body.k === 'd' ? 'd' : 'f';
    const r = String(body.r || '');
    const p = String(body.p || '').replace(/^\/+|\/+$/g, '');
    const root = findRoot(r);
    if (!root) throw new HttpError(404, '媒体源不存在');
    if (k === 'f' && !p) throw new HttpError(400, '缺少文件路径');
    const key = favKey(k, r, p);
    const on = body.on === undefined ? !favSet.has(key) : !!body.on;
    config.favorites = config.favorites.filter((f) => favKey(f.k, f.r, f.p) !== key);
    if (on) config.favorites.push({ k, r, p, t: Date.now() });
    rebuildFavSet();
    saveConfig();
    queryCache.clear();
    return send(res, 200, { on });
  }

  if (route === 'report-dim' && method === 'POST') {
    // 前端播放时回报视频真实分辨率（无 ffprobe 的兜底）
    const root = findRoot(String(body.r || ''));
    const kind = kindOfExt(extOf(String(body.p || '')));
    if (root && kind) {
      const it = getIndex(root.id, kind).map.get(String(body.p));
      if (it && !it.w && body.w > 0 && body.h > 0) {
        it.w = Math.round(body.w); it.h = Math.round(body.h);
        if (body.t > 0 && !it.t) it.t = body.t;
        const idx = getIndex(root.id, kind);
        idx.version++;
      }
    }
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, '接口不存在');
}

function mediaTarget(u, prefix) {
  const rest = u.pathname.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const root = findRoot(rest.slice(0, slash));
  let rel;
  try { rel = decodeURIComponent(rest.slice(slash + 1)); } catch { return null; }
  if (!root) return null;
  const ext = extOf(rel);
  if (!kindOfExt(ext)) return null;
  const abs = resolveInRoot(root, rel);
  return abs ? { root, rel, abs, ext } : null;
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const abs = path.join(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  serveFile(req, res, abs, MIME[extOf(rel)] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) return send(res, 403, 'Forbidden');
    const u = new URL(req.url, 'http://localhost');
    const pn = u.pathname;
    if (TOKEN && !authorize(req, res, u)) return;

    if (pn.startsWith('/api/')) return await api(req, res, u);

    if (pn.startsWith('/file/')) {
      const t = mediaTarget(u, '/file/');
      if (!t) return send(res, 404, 'Not found');
      return serveFile(req, res, t.abs, MIME[normExt(t.ext)] || MIME[t.ext] || 'application/octet-stream');
    }

    if (pn.startsWith('/sub/')) {
      const rest = pn.slice(5);
      const slash = rest.indexOf('/');
      const root = slash > 0 && findRoot(rest.slice(0, slash));
      let rel = '';
      try { rel = decodeURIComponent(rest.slice(slash + 1)); } catch { /* 忽略 */ }
      const abs = root && /\.(srt|vtt)$/i.test(rel) ? resolveInRoot(root, rel) : null;
      if (!abs || !fs.existsSync(abs)) return send(res, 404, 'Not found');
      return send(res, 200, Buffer.from(readSubAsVtt(abs), 'utf8'), { 'Content-Type': 'text/vtt; charset=utf-8' });
    }

    if (pn.startsWith('/thumb/')) {
      const t = mediaTarget(u, '/thumb/');
      if (!t || !caps.ffmpeg) return send(res, 404, 'Not found');
      const w = Math.min(1200, Math.max(120, parseInt(u.searchParams.get('w'), 10) || 480));
      const out = await getThumb(t.root, t.rel, w).catch(() => null);
      if (!out) return send(res, 404, 'Not found');
      return serveFile(req, res, out, 'image/jpeg', 'public, max-age=604800');
    }

    if (pn.startsWith('/transcode/')) {
      const t = mediaTarget(u, '/transcode/');
      if (!t || !caps.ffmpeg || kindOfExt(t.ext) !== 'video') return send(res, 404, 'Not found');
      // 浏览器不支持的封装 / 编码：实时转成 fragmented MP4 (H.264 + AAC)，不支持拖动进度条
      const pr = spawn('ffmpeg', [
        '-v', 'error', '-i', t.abs, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p', '-vf', 'scale=-2:min(ih\\,1080)', '-c:a', 'aac', '-b:a', '160k',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
      pr.stdout.pipe(res);
      res.on('close', () => pr.kill('SIGKILL'));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, pn);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: '服务器内部错误' });
    else res.destroy();
  }
});

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  loadConfig();
  caps.ffprobe = (await run('ffprobe', ['-version'])) !== null;
  caps.ffmpeg = (await run('ffmpeg', ['-version'])) !== null;
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用，可用 PORT=xxxx 换一个端口` : e);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
    console.log('\n  本地媒体库已启动');
    console.log(`  → http://${shown}:${PORT}`);
    console.log(`  ffmpeg: ${caps.ffmpeg ? '可用（缩略图 / 转码播放）' : '未检测到（使用原图 / 浏览器内抽帧作为缩略图）'}`);
    console.log(`  ffprobe: ${caps.ffprobe ? '可用' : '未检测到（MP4/MOV 仍可解析分辨率，其它视频格式分辨率为"未知"）'}`);
    if (TOKEN) console.log(`  访问口令已启用：首次请打开 http://${shown}:${PORT}/?token=${TOKEN}`);
    else if (HOST !== '127.0.0.1' && HOST !== 'localhost') console.log('  ⚠ 已对外监听且没有设置口令：后台可浏览本机目录。建议加上 GALLERY_TOKEN=口令');
    console.log(`  数据目录: ${DATA_DIR}\n`);
  });
}

main();
