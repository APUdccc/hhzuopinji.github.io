(() => {
'use strict';

/* ═════════════ 工具 ═════════════ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, cls = '') => `<svg class="ic ${cls}"><use href="#i-${n}"/></svg>`;
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const fileUrl = (it) => `/file/${it.r}/${encPath(it.p)}`;
const thumbUrl = (it, w = 480) => `/thumb/${it.r}/${encPath(it.p)}?w=${w}&v=${it.m}`;
const transcodeUrl = (it) => `/transcode/${it.r}/${encPath(it.p)}`;

function fmtSize(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
function fmtDur(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function fmtDate(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return fmtDate(ms);
}

const RES_LABEL = { '8k': '8K', '4k': '4K', '2k': '2K', 1080: '1080p', 720: '720p', 480: '480p', sd: '<480p', unk: '未知' };

async function api(url, opt) {
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `请求失败 (${r.status})`);
  return j;
}
const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

function toast(msg, err) {
  const t = el('div', 'toast' + (err ? ' err' : ''), esc(msg));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 4200 : 2200);
}

/* ═════════════ 状态 ═════════════ */
const PREF_KEY = 'mg.prefs.v1';
const POS_KEY = 'mg.pos.v1';
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 忽略 */ } };

const P = Object.assign({
  mode: 'video', lastLib: 'video', root: '', dir: '', rec: false, sort: 'name', order: 'asc', group: 'none',
  view: 'grid', size: 230, fit: 'cover', theme: 'dark', autoNext: true, rate: 1, vol: 1, muted: false, expanded: [], favKind: 'all',
}, lsGet(PREF_KEY, {}));
const savePrefs = () => lsSet(PREF_KEY, { ...P, expanded: [...S.expanded] });

const S = {
  info: null, roots: [], favDirs: [],
  expanded: new Set(P.expanded),
  q: '', types: new Set(), res: new Set(), favOnly: false,
  items: [], total: 0, folders: [], facets: { types: [], res: [] }, groupCounts: {},
  loading: false, req: 0, lastG: null, treeCache: new Map(), counts: new Map(),
};
const PAGE = 240;
const caps = () => (S.info && S.info.caps) || {};
const libKind = () => (P.mode === 'fav' ? P.lastLib : P.mode);
const rootById = (id) => S.roots.find((r) => r.id === id);

/* ═════════════ 启动 ═════════════ */
async function boot() {
  document.documentElement.dataset.theme = P.theme;
  setThemeIcon();
  try {
    S.info = await api('/api/info');
  } catch {
    document.body.insertAdjacentHTML('beforeend', `<div class="offline"><div class="empty">
      <div class="empty-ic">${icon('alert')}</div><h3>没有连接到本地服务</h3>
      <p>浏览器无法直接读取本机路径，需要先启动随附的本地服务。请在终端执行：</p>
      <pre>cd media-gallery\nnode server.js</pre>
      <p>然后访问 <b>http://localhost:8686</b>（Windows 可直接双击 <b>启动.bat</b>）。</p></div></div>`);
    return;
  }
  bindUI();
  applyPrefsToUI();
  await refreshRoots();
  if (P.root && !rootById(P.root)) { P.root = ''; P.dir = ''; }
  await refreshFavDirs();
  renderTree();
  renderHead();
  loadItems(true);
  autoVideoScan();
}

async function refreshRoots() {
  S.roots = await api('/api/roots');
  for (const r of S.roots) for (const k of ['image', 'video']) S.counts.set(`${r.id}|${k}`, r.scans[k].count);
  if (S.roots.some((r) => r.scans.image.state === 'running' || r.scans.video.state === 'running')) ensurePolling();
}

async function refreshFavDirs() {
  S.favDirs = (await api('/api/favorites')).dirs;
  renderFavDirs();
}

function autoVideoScan() {
  const stale = S.roots.filter((r) => {
    const s = r.scans.video;
    return r.exists && s.state !== 'running' && (s.state === 'none' || Date.now() - s.updatedAt > 5 * 60 * 1000);
  });
  if (!stale.length) return;
  Promise.all(stale.map((r) => post('/api/scan', { root: r.id, kind: 'video', action: 'start' }))).then(() => afterScanKick());
}

/* ═════════════ 扫描轮询 ═════════════ */
let pollTimer = null;
function ensurePolling() {
  if (!pollTimer) pollTimer = setInterval(pollOnce, 900);
}
async function pollOnce() {
  let roots;
  try { roots = await api('/api/roots'); } catch { return; }
  const prev = S.roots;
  S.roots = roots;
  let finishedHere = false, grewHere = false, running = false;
  const kind = libKind();
  for (const r of roots) {
    const old = prev.find((x) => x.id === r.id);
    for (const k of ['image', 'video']) {
      const s = r.scans[k];
      if (s.state === 'running') running = true;
      const was = old ? old.scans[k] : null;
      const ck = `${r.id}|${k}`;
      if (was && s.state !== 'running' && (was.state === 'running' || was.updatedAt !== s.updatedAt)) {
        for (const key of [...S.treeCache.keys()]) if (key.startsWith(`${k}|${r.id}|`)) S.treeCache.delete(key);
        if (k === kind) finishedHere = true;
      }
      if (k === kind && S.counts.get(ck) !== s.count) grewHere = true;
      S.counts.set(ck, s.count);
    }
  }
  if (!running) { clearInterval(pollTimer); pollTimer = null; }
  renderBanner();
  updateTreeTags();
  if (!$('#admin').hidden) renderAdminRoots();
  if (P.mode !== 'fav' && (finishedHere || (grewHere && running && S.items.length < 60))) {
    if (finishedHere) renderTree();
    loadItems(true, { keepScroll: true });
  }
}

/* ═════════════ 数据加载 ═════════════ */
function queryString(offset) {
  const p = new URLSearchParams();
  if (P.mode === 'fav') {
    p.set('scope', 'fav');
    p.set('kind', P.favKind);
  } else {
    p.set('kind', P.mode);
    p.set('root', P.root);
    p.set('dir', P.dir);
    if (P.rec) p.set('rec', '1');
    if (S.favOnly) p.set('favOnly', '1');
  }
  if (S.q) p.set('q', S.q);
  if (S.types.size) p.set('types', [...S.types].join(','));
  if (S.res.size) p.set('res', [...S.res].join(','));
  p.set('sort', P.sort);
  p.set('order', P.order);
  p.set('group', P.group);
  p.set('offset', offset);
  p.set('limit', PAGE);
  return p.toString();
}

async function loadItems(reset, opts = {}) {
  if (reset) { S.req++; S.loading = false; }
  if (S.loading) return;
  if (!reset && S.items.length >= S.total) return;
  const id = S.req;
  S.loading = true;
  let j;
  try {
    j = await api(`/api/items?${queryString(reset ? 0 : S.items.length)}`);
  } catch (e) {
    if (id === S.req) { S.loading = false; toast(e.message, true); }
    return;
  }
  if (id !== S.req) return;
  S.loading = false;
  if (reset) {
    S.items = j.items;
    S.total = j.total;
    S.facets = j.facets || S.facets;
    S.groupCounts = {};
    for (const g of j.groups || []) S.groupCounts[g.g] = g.count;
    S.folders = j.folders || [];
    if (P.mode === 'fav' && P.favKind === 'all' && !S.q && !S.types.size && !S.res.size) {
      S.folders = S.favDirs.map((d) => ({ r: d.r, dir: d.dir, name: d.name, total: d.videos + d.images, f: 1, sub: `${d.rootName} · 视频 ${d.videos} · 图片 ${d.images}` }));
    } else if (P.mode === 'fav') {
      S.folders = [];
    }
    renderFilters();
    renderHead();
    renderAll(opts.keepScroll);
  } else {
    const from = S.items.length;
    S.items.push(...j.items);
    appendItems(from);
  }
  if (V.open) updateViewerNav();
}

/* ═════════════ 渲染：头部 / 过滤 ═════════════ */
function setThemeIcon() {
  $('#theme').innerHTML = icon(P.theme === 'dark' ? 'sun' : 'moon');
}

function applyPrefsToUI() {
  $$('#modeTabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === P.mode));
  $$('#viewSeg button').forEach((b) => b.classList.toggle('active', b.dataset.view === P.view));
  $('#sort').value = P.sort;
  $('#order').textContent = P.order === 'asc' ? '↑' : '↓';
  $('#size').value = P.size;
  document.documentElement.style.setProperty('--card-w', `${P.size}px`);
}

function renderHead() {
  const c = $('#crumbs'), a = $('#mactions');
  if (P.mode === 'fav') {
    c.innerHTML = `<span class="crumb cur">${icon('star', 'star-ic')} 收藏夹</span>`;
    a.innerHTML = `<span class="count">${S.total} 个文件${S.folders.length ? ` · ${S.folders.length} 个文件夹` : ''}</span>`;
    return;
  }
  const parts = [`<button class="crumb${!P.root ? ' cur' : ''}" data-go="" data-dir="">全部来源</button>`];
  if (P.root) {
    const root = rootById(P.root);
    const segs = P.dir ? P.dir.split('/') : [];
    parts.push(`<span class="crumb-sep">${icon('chevron')}</span><button class="crumb${!segs.length ? ' cur' : ''}" data-go="${P.root}" data-dir="">${esc(root ? root.name : P.root)}</button>`);
    segs.forEach((s, i) => {
      const d = segs.slice(0, i + 1).join('/');
      parts.push(`<span class="crumb-sep">${icon('chevron')}</span><button class="crumb${i === segs.length - 1 ? ' cur' : ''}" data-go="${P.root}" data-dir="${esc(d)}">${esc(s)}</button>`);
    });
    const faved = S.favDirs.some((d) => d.r === P.root && d.dir === P.dir);
    parts.push(`<button class="tn-star crumb-fav${faved ? ' on' : ''}" style="display:grid" data-favcur title="收藏此文件夹">${icon('star')}</button>`);
  }
  c.innerHTML = parts.join('');
  const kind = P.mode;
  let h = '';
  if (P.root) h += `<label class="switch${P.rec ? ' on' : ''}" data-act="rec"><i></i>包含子目录</label>`;
  h += `<span class="count">${S.total} ${kind === 'video' ? '个视频' : '张图片'}</span>`;
  const unscanned = scopeRoots().every((r) => r.scans[kind].state === 'none');
  if (kind === 'image') { if (!unscanned) h += `<button class="btn sm" data-act="scan">${icon('scan')}重新扫描</button>`; }
  else h += `<button class="btn sm" data-act="scan">${icon('refresh')}刷新</button>`;
  a.innerHTML = h;
}

function chip(attr, val, label, count, on, extra = '') {
  return `<button class="chip${on ? ' on' : ''} ${extra}" data-f="${attr}" data-v="${esc(val)}">${label}${count != null ? ` <small>${count}</small>` : ''}</button>`;
}

function renderFilters() {
  let h = '';
  if (P.mode === 'fav') {
    h += `<div class="fgroup"><span class="flabel">种类</span>${[['all', '全部'], ['video', '视频'], ['image', '图片']].map(([v, l]) => chip('favkind', v, l, null, P.favKind === v)).join('')}</div>`;
  } else {
    h += `<div class="fgroup">${chip('fav', '1', `${icon('star')}仅收藏`, null, S.favOnly, 'star')}</div>`;
  }
  const groups = [['none', '不分组'], ['name', '名称'], ['type', '类型'], ['res', '分辨率'], ['dir', '目录']];
  h += `<div class="fgroup"><span class="flabel">分类</span>${groups.map(([v, l]) => chip('group', v, l, null, P.group === v)).join('')}</div>`;

  const types = S.facets.types.slice();
  for (const t of S.types) if (!types.some((x) => x.e === t)) types.push({ e: t, count: 0 });
  if (types.length > 1 || S.types.size) {
    h += `<div class="fgroup"><span class="flabel">类型</span>${types.slice(0, 14).map((t) => chip('type', t.e, t.e.toUpperCase(), t.count, S.types.has(t.e))).join('')}</div>`;
  }
  const res = S.facets.res.slice();
  for (const r of S.res) if (!res.some((x) => x.b === r)) res.push({ b: r, count: 0 });
  if (res.length > 1 || S.res.size) {
    h += `<div class="fgroup"><span class="flabel">分辨率</span>${res.map((r) => chip('res', r.b, RES_LABEL[r.b], r.count, S.res.has(r.b))).join('')}</div>`;
  }
  if (S.types.size || S.res.size || S.q) h += `<div class="fgroup">${chip('clear', '1', '清除筛选', null, false, 'clear')}</div>`;
  $('#filters').innerHTML = h;
}

/* ═════════════ 渲染：横幅 / 空状态 ═════════════ */
function scopeRoots() {
  return S.roots.filter((r) => r.exists && (!P.root || r.id === P.root));
}

function renderBanner() {
  const b = $('#banner');
  if (P.mode === 'fav') { b.innerHTML = ''; return; }
  const kind = P.mode;
  const roots = scopeRoots();
  const running = roots.filter((r) => r.scans[kind].state === 'running');
  const missing = S.roots.filter((r) => !r.exists && (!P.root || r.id === P.root));
  let h = '';
  if (running.length) {
    const found = running.reduce((n, r) => n + r.scans[kind].found, 0);
    const probed = running.reduce((n, r) => n + r.scans[kind].probed, 0);
    const pct = found ? Math.min(100, Math.round((probed / found) * 100)) : 0;
    h = `<div class="banner"><span class="spin"></span><div class="grow"><div>正在扫描 <b>${esc(running.map((r) => r.name).join('、'))}</b> —— 已发现 <b>${found}</b> 个${kind === 'video' ? '视频' : '图片'}，已解析分辨率 ${probed}</div><div class="progress ${found ? '' : 'indet'}"><i style="width:${pct}%"></i></div></div><button class="btn sm" data-act="cancel">取消</button></div>`;
  } else if (kind === 'image') {
    const un = roots.filter((r) => r.scans.image.state === 'none');
    if (un.length && S.total > 0) {
      h = `<div class="banner warn"><div class="grow">还有 <b>${un.length}</b> 个来源尚未扫描图片：${esc(un.map((r) => r.name).join('、'))}</div><button class="btn sm primary" data-act="scanun">开始扫描</button></div>`;
    }
  }
  for (const r of roots) {
    const s = r.scans[kind];
    if (s.state === 'error') h += `<div class="banner err"><div class="grow">「${esc(r.name)}」扫描失败：${esc(s.error)}</div></div>`;
  }
  if (missing.length) h += `<div class="banner err"><div class="grow">路径不可用：${esc(missing.map((r) => `${r.name} (${r.path})`).join('、'))}</div><button class="btn sm" data-act="admin">去后台处理</button></div>`;
  b.innerHTML = h;
}

function emptyHTML() {
  if (!S.roots.length) {
    return `<div class="empty"><div class="empty-ic">${icon('folder')}</div><h3>先添加一个媒体路径</h3>
      <p>在「后台」里添加本机上存放视频或图片的文件夹，之后就能在这里浏览、播放和收藏。</p>
      <div class="acts"><button class="btn primary" data-act="admin">${icon('settings')}打开后台</button></div></div>`;
  }
  if (P.mode === 'fav') {
    return `<div class="nores">${icon('star')}<div>还没有收藏内容<br><small>在缩略图右上角点 ☆，或在文件夹旁点星标即可收藏</small></div></div>`;
  }
  const kind = P.mode;
  const roots = scopeRoots();
  const un = roots.filter((r) => r.scans[kind].state === 'none');
  const running = roots.some((r) => r.scans[kind].state === 'running');
  if (kind === 'image' && un.length && !running) {
    const rows = roots.map((r) => {
      const s = r.scans.image;
      const st = s.state === 'none' ? '尚未扫描' : s.state === 'running' ? '扫描中…' : `已扫描 ${s.count} 张 · ${ago(s.updatedAt)}`;
      return `<div class="rrow">${icon('folder')}<div class="grow"><b>${esc(r.name)}</b><small>${esc(r.path)}</small></div><span class="pill ${s.state === 'none' ? '' : 'ok'}">${st}</span>${s.state === 'none' ? `<button class="btn sm primary" data-act="scan1" data-root="${r.id}">${icon('scan')}扫描</button>` : ''}</div>`;
    }).join('');
    return `<div class="empty"><div class="empty-ic">${icon('image')}</div><h3>图片库需要手动开启扫描</h3>
      <p>图片数量通常很大，为避免占用磁盘和 CPU，只有点击「开始扫描」后才会遍历目录、读取分辨率并建立索引。扫描结果会被缓存，下次打开直接可用。</p>
      <div class="roots">${rows}</div>
      <div class="acts"><button class="btn primary" data-act="scanun">${icon('scan')}开始扫描${roots.length > 1 ? '全部' : ''}</button></div></div>`;
  }
  if (running) return '';
  return `<div class="nores">${icon(kind === 'video' ? 'video' : 'image')}<div>${S.q || S.types.size || S.res.size || S.favOnly ? '没有符合条件的内容' : '这里还没有' + (kind === 'video' ? '视频' : '图片')}</div></div>`;
}

/* ═════════════ 渲染：网格 ═════════════ */
function groupLabel(g) {
  return P.group === 'res' ? RES_LABEL[g] || g : g;
}
function groupHead(g) {
  return `<div class="gh"><b>${esc(groupLabel(g))}</b><span>${S.groupCounts[g] || ''} 项</span></div>`;
}

function resBadge(it) {
  if (it.b === 'unk') return '';
  const cls = it.b === '8k' ? ' hd8' : it.b === '4k' ? ' hd4' : '';
  return `<span class="badge b-res${cls}">${RES_LABEL[it.b]}</span>`;
}

function thumbInner(it) {
  const useThumb = caps().ffmpeg;
  if (it.k === 'image') return `<img loading="lazy" decoding="async" alt="" src="${useThumb ? thumbUrl(it) : fileUrl(it)}" data-orig="${useThumb ? 1 : 0}">`;
  return useThumb
    ? `<img loading="lazy" decoding="async" alt="" src="${thumbUrl(it)}" data-orig="0">`
    : `<div class="ph">${icon('video')}</div>`;
}

function cardHTML(it, i) {
  const v = it.k === 'video';
  const sub = [it.w ? `${it.w}×${it.h}` : '', fmtSize(it.s)].filter(Boolean).join(' · ');
  return `<div class="card" data-i="${i}" data-k="${it.k}" title="${esc(it.p)}">
    <div class="thumb"${v && !caps().ffmpeg ? ' data-v="1"' : ''}>${thumbInner(it)}
      <span class="badge b-ext">${esc(it.e)}</span>${resBadge(it)}${v && it.t ? `<span class="badge b-dur">${fmtDur(it.t)}</span>` : ''}
      ${v ? `<div class="play-ov"><span>${icon('play')}</span></div>` : ''}
      <button class="fav-btn${it.f ? ' on' : ''}" data-fav title="收藏">${icon('star')}</button>
    </div>
    <div class="meta"><div class="name">${esc(it.n)}</div><div class="sub">${esc(sub)}</div></div>
  </div>`;
}

function rowHTML(it, i) {
  const v = it.k === 'video';
  return `<div class="row" data-i="${i}" data-k="${it.k}">
    <div class="rthumb thumb"${v && !caps().ffmpeg ? ' data-v="1"' : ''}>${thumbInner(it)}</div>
    <div class="rname"><b>${esc(it.n)}</b><small>${esc(it.d || '（根目录）')}</small></div>
    <div class="c t"><span class="tag">${esc(it.e)}</span></div>
    <div class="c r">${it.w ? `${it.w}×${it.h}` : '—'}${it.b !== 'unk' ? ` <span class="tag">${RES_LABEL[it.b]}</span>` : ''}</div>
    <div class="c s">${fmtSize(it.s)}</div>
    <div class="c m">${fmtDate(it.m)}</div>
    <div class="c d">${v && it.t ? fmtDur(it.t) : ''}</div>
    <button class="fav-btn${it.f ? ' on' : ''}" data-fav title="收藏">${icon('star')}</button>
  </div>`;
}

function folderCardHTML(f) {
  return `<div class="fcard" data-r="${f.r}" data-dir="${esc(f.dir)}">
    <div class="fic">${icon('folder')}</div>
    <div class="ftx"><b title="${esc(f.dir || f.name)}">${esc(f.name)}</b><small>${esc(f.sub || `${f.total} 项`)}</small></div>
    <button class="fav-btn${f.f ? ' on' : ''}" data-favdir title="收藏文件夹">${icon('star')}</button>
  </div>`;
}

function renderAll(keepScroll) {
  const main = $('#main'), grid = $('#grid');
  const top = main.scrollTop;
  grid.className = `grid${P.view === 'list' ? ' list' : ''}${P.fit === 'contain' ? ' fit-contain' : ''}`;
  S.lastG = null;
  vio.disconnect();
  let html = '';
  if (S.folders.length) html += `<div class="folders">${S.folders.map(folderCardHTML).join('')}</div>`;
  if (!S.items.length && !S.folders.length) html += emptyHTML();
  else if (P.view === 'list' && S.items.length) html += `<div class="rhead"><span></span><span>名称</span><span class="t">类型</span><span>分辨率</span><span class="s">大小</span><span class="m">修改时间</span><span class="d">时长</span><span></span></div>`;
  grid.innerHTML = html;
  renderBanner();
  appendItems(0);
  main.scrollTop = keepScroll ? top : 0;
}

function appendItems(from) {
  const grid = $('#grid');
  let html = '';
  for (let i = from; i < S.items.length; i++) {
    const it = S.items[i];
    if (P.group !== 'none' && it.g !== S.lastG) { S.lastG = it.g; html += groupHead(it.g); }
    html += P.view === 'list' ? rowHTML(it, i) : cardHTML(it, i);
  }
  grid.insertAdjacentHTML('beforeend', html);
  $$('.thumb[data-v]:not([data-o])', grid).forEach((t) => { t.dataset.o = 1; vio.observe(t); });
  sentinelCheck();
}

/* 没有 ffmpeg 时：视频缩略图用浏览器抽帧（只给可见区域加载，离开就释放） */
const vio = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const th = e.target;
    const old = th.querySelector('video.tv');
    if (e.isIntersecting && !old) {
      const host = th.closest('[data-i]');
      const it = host && S.items[+host.dataset.i];
      if (!it) continue;
      const v = document.createElement('video');
      v.className = 'tv'; v.muted = true; v.preload = 'metadata'; v.playsInline = true;
      v.addEventListener('loadedmetadata', () => reportDim(it, v), { once: true });
      v.src = `${fileUrl(it)}#t=0.5`;
      th.insertBefore(v, th.firstChild);
    } else if (!e.isIntersecting && old) {
      old.removeAttribute('src'); old.load(); old.remove();
    }
  }
}, { root: null, rootMargin: '300px' });

function reportDim(it, v) {
  if (it.w || !v.videoWidth) return;
  it.w = v.videoWidth; it.h = v.videoHeight; it.t = it.t || v.duration || 0;
  post('/api/report-dim', { r: it.r, p: it.p, w: it.w, h: it.h, t: v.duration || 0 }).catch(() => {});
}

/* 缩略图失败时回退 */
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.closest('#grid')) return;
  const host = img.closest('[data-i]');
  const it = host && S.items[+host.dataset.i];
  if (!it) return;
  if (it.k === 'image' && img.dataset.orig === '1') { img.dataset.orig = '0'; img.src = fileUrl(it); return; }
  if (it.k === 'video') {
    const th = img.closest('.thumb');
    img.remove();
    if (th && !th.dataset.o) { th.dataset.v = 1; th.dataset.o = 1; th.insertAdjacentHTML('afterbegin', `<div class="ph">${icon('video')}</div>`); vio.observe(th); }
  }
}, true);

/* 无限滚动 */
const sentinelIO = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadItems(false); }, { root: null, rootMargin: '900px' });
function sentinelCheck() {
  sentinelIO.disconnect();
  sentinelIO.observe($('#sentinel'));
}

/* 悬停预览 */
let hoverCard = null, hoverTimer = 0;
function endHover() {
  clearTimeout(hoverTimer);
  if (hoverCard) { const pv = hoverCard.querySelector('video.pv'); if (pv) { pv.removeAttribute('src'); pv.load(); pv.remove(); } }
  hoverCard = null;
}
function bindHover(grid) {
  grid.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.card[data-k="video"]');
    if (!card || card === hoverCard) return;
    endHover();
    hoverCard = card;
    hoverTimer = setTimeout(() => {
      const it = S.items[+card.dataset.i];
      const th = card.querySelector('.thumb');
      if (!it || !th) return;
      const v = document.createElement('video');
      v.className = 'pv'; v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true; v.preload = 'auto';
      v.src = fileUrl(it);
      v.addEventListener('playing', () => { v.style.opacity = 1; });
      v.style.opacity = 0;
      th.insertBefore(v, th.querySelector('.badge'));
    }, 450);
  });
  grid.addEventListener('mouseout', (e) => {
    if (hoverCard && !hoverCard.contains(e.relatedTarget)) endHover();
  });
}

/* ═════════════ 侧边栏：目录树 ═════════════ */
const treeKey = (r, d) => `${r}|${d}`;

async function getChildren(root, dir) {
  const kind = libKind();
  const key = `${kind}|${root}|${dir}`;
  if (S.treeCache.has(key)) return S.treeCache.get(key);
  const j = await api(`/api/tree?kind=${kind}&root=${root}&dir=${encodeURIComponent(dir)}`);
  S.treeCache.set(key, j.children);
  return j.children;
}

function isSel(root, dir) {
  return P.mode !== 'fav' && P.root === root && P.dir === dir;
}

function nodeEl({ root, dir, name, tag, count, hasKids }) {
  const wrap = el('div', 'tn');
  wrap.dataset.root = root; wrap.dataset.dir = dir;
  const open = S.expanded.has(treeKey(root, dir));
  const faved = S.favDirs.some((d) => d.r === root && d.dir === dir);
  const row = el('div', `tn-row${isSel(root, dir) ? ' sel' : ''}`,
    `<button class="tn-arrow ${hasKids ? (open ? 'open' : '') : 'none'}">${icon('chevron')}</button>${icon('folder')}<span class="tn-name" title="${esc(name)}">${esc(name)}</span>` +
    (tag ? `<span class="tn-tag ${tag.warn ? 'warn' : ''}" data-tag>${tag.text}</span>` : `<span class="tn-count">${count}</span>`) +
    `<button class="tn-star${faved ? ' on' : ''}" data-favnode title="收藏">${icon('star')}</button>`);
  wrap.append(row);
  if (open && hasKids) {
    const kids = el('div', 'tn-kids');
    wrap.append(kids);
    fillKids(wrap, kids, root, dir);
  }
  return wrap;
}

async function fillKids(wrap, kids, root, dir) {
  const list = await getChildren(root, dir);
  if (!list.length) {
    const arrow = $('.tn-arrow', wrap);
    arrow.className = 'tn-arrow none';
    kids.remove();
    return;
  }
  kids.innerHTML = '';
  for (const c of list) kids.append(nodeEl({ root, dir: c.dir, name: c.name, count: c.total, hasKids: c.hasKids }));
}

function rootTag(r, kind) {
  const s = r.scans[kind];
  if (!r.exists) return { text: '路径失效', warn: true };
  if (s.state === 'running') return { text: '扫描中…', warn: true };
  if (s.state === 'none') return { text: '未扫描' };
  return null;
}

function renderTree() {
  const host = $('#tree');
  const kind = libKind();
  host.innerHTML = '';
  if (!S.roots.length) {
    host.innerHTML = '<div class="tn-empty">还没有媒体路径。<br>点右上角「后台」或上方 ＋ 添加。</div>';
    return;
  }
  const all = S.roots.reduce((n, r) => n + r.scans[kind].count, 0);
  const allRow = el('div', 'tn');
  allRow.dataset.root = ''; allRow.dataset.dir = '';
  allRow.innerHTML = `<div class="tn-row${isSel('', '') ? ' sel' : ''}"><button class="tn-arrow none">${icon('chevron')}</button>${icon('layers')}<span class="tn-name">全部来源</span><span class="tn-count">${all}</span></div>`;
  host.append(allRow);
  for (const r of S.roots) {
    const s = r.scans[kind];
    host.append(nodeEl({ root: r.id, dir: '', name: r.name, tag: rootTag(r, kind), count: s.count, hasKids: s.count > 0 }));
  }
}

function updateTreeTags() {
  const kind = libKind();
  const all = S.roots.reduce((n, r) => n + r.scans[kind].count, 0);
  const a = $('#tree .tn[data-root=""] .tn-count');
  if (a) a.textContent = all;
  for (const r of S.roots) {
    const wrap = $(`#tree > .tn[data-root="${r.id}"]`);
    if (!wrap) continue;
    const row = $(':scope > .tn-row', wrap);
    const tag = rootTag(r, kind);
    const cur = $('[data-tag], .tn-count', row);
    if (!cur) continue;
    if (tag) { cur.className = `tn-tag ${tag.warn ? 'warn' : ''}`; cur.dataset.tag = 1; cur.textContent = tag.text; }
    else { cur.className = 'tn-count'; delete cur.dataset.tag; cur.textContent = r.scans[kind].count; }
  }
}

function markSel() {
  $$('#tree .tn').forEach((n) => {
    const row = $(':scope > .tn-row', n);
    if (row) row.classList.toggle('sel', isSel(n.dataset.root, n.dataset.dir));
  });
}

function renderFavDirs() {
  const host = $('#favDirs');
  if (!S.favDirs.length) { host.innerHTML = '<div class="tn-empty">点文件夹旁的 ☆ 即可收藏，<br>下次一键直达。</div>'; return; }
  host.innerHTML = S.favDirs.map((d) => `<div class="tn" data-fr="${d.r}" data-fdir="${esc(d.dir)}"><div class="tn-row" title="${esc(d.rootName)} / ${esc(d.dir)}"><button class="tn-arrow none">${icon('chevron')}</button>${icon('folder')}<span class="tn-name">${esc(d.name)}</span><span class="tn-count">${d.videos + d.images}</span><button class="tn-star on" data-unfav>${icon('star')}</button></div></div>`).join('');
}

/* ═════════════ 导航 ═════════════ */
function navigate(root, dir, opts = {}) {
  if (P.mode === 'fav') P.mode = P.lastLib;
  P.root = root; P.dir = dir;
  if (root) {
    S.expanded.add(treeKey(root, ''));
    const segs = dir ? dir.split('/') : [];
    for (let i = 1; i < segs.length; i++) S.expanded.add(treeKey(root, segs.slice(0, i).join('/')));
  }
  S.types.clear(); S.res.clear(); S.favOnly = false;
  savePrefs();
  applyPrefsToUI();
  if (opts.rebuildTree !== false) renderTree(); else markSel();
  renderHead();
  loadItems(true);
  closeSide();
}

function setMode(mode) {
  if (P.mode === mode) return;
  P.mode = mode;
  if (mode !== 'fav') { P.lastLib = mode; P.dir = ''; }
  S.types.clear(); S.res.clear(); S.favOnly = false;
  savePrefs();
  applyPrefsToUI();
  renderTree();
  if (mode === 'fav') refreshFavDirs().then(() => { if (P.mode === 'fav') loadItems(true); });
  else loadItems(true);
  renderHead();
  closeSide();
  if (mode === 'video') autoVideoScan();
}

function openSide() { $('#side').classList.add('open'); $('#sideMask').classList.add('open'); }
function closeSide() { $('#side').classList.remove('open'); $('#sideMask').classList.remove('open'); }

/* ═════════════ 扫描 & 收藏操作 ═════════════ */
async function afterScanKick() {
  await sleep(150);
  await refreshRoots();
  renderTree();
  renderBanner();
  if (P.mode !== 'fav') loadItems(true, { keepScroll: true });
}

async function startScan(rootId, kind) {
  try {
    await post('/api/scan', { root: rootId || '', kind, action: 'start' });
    await afterScanKick();
  } catch (e) { toast(e.message, true); }
}

async function startUnscanned() {
  const kind = P.mode;
  const targets = scopeRoots().filter((r) => r.scans[kind].state === 'none' || r.scans[kind].state === 'error');
  if (!targets.length) return;
  try {
    await Promise.all(targets.map((r) => post('/api/scan', { root: r.id, kind, action: 'start' })));
    await afterScanKick();
  } catch (e) { toast(e.message, true); }
}

async function toggleFavFile(it) {
  try {
    const { on } = await post('/api/fav', { k: 'f', r: it.r, p: it.p, on: !it.f });
    it.f = on ? 1 : 0;
    const i = S.items.indexOf(it);
    $$(`#grid [data-i="${i}"] .fav-btn`).forEach((b) => b.classList.toggle('on', on));
    if (V.open && V.i === i) updateViewerFav();
    toast(on ? '已加入收藏夹' : '已取消收藏');
  } catch (e) { toast(e.message, true); }
}

async function toggleFavDir(r, dir) {
  try {
    const cur = S.favDirs.some((d) => d.r === r && d.dir === dir);
    await post('/api/fav', { k: 'd', r, p: dir, on: !cur });
    await refreshFavDirs();
    $$('#tree .tn').forEach((n) => {
      if (n.dataset.root === r && n.dataset.dir === dir) $(':scope > .tn-row .tn-star', n).classList.toggle('on', !cur);
    });
    $$('#grid .fcard').forEach((c) => { if (c.dataset.r === r && c.dataset.dir === dir) $('.fav-btn', c).classList.toggle('on', !cur); });
    const cf = $('[data-favcur]');
    if (cf) cf.classList.toggle('on', P.root === r && P.dir === dir ? !cur : cf.classList.contains('on'));
    toast(!cur ? '文件夹已收藏' : '已取消收藏');
  } catch (e) { toast(e.message, true); }
}

/* ═════════════ 事件绑定 ═════════════ */
function bindUI() {
  $('#modeTabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) setMode(b.dataset.mode); });
  $('#btnSide').onclick = openSide;
  $('#sideMask').onclick = closeSide;
  $('#btnAdmin').onclick = openAdmin;
  $('#btnAddRoot').onclick = () => openAdmin(true);

  let qt;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qt);
    qt = setTimeout(() => { S.q = e.target.value.trim(); loadItems(true); }, 220);
  });
  $('#sort').onchange = (e) => { P.sort = e.target.value; savePrefs(); loadItems(true); };
  $('#order').onclick = () => { P.order = P.order === 'asc' ? 'desc' : 'asc'; applyPrefsToUI(); savePrefs(); loadItems(true); };
  $('#viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    P.view = b.dataset.view; savePrefs(); applyPrefsToUI(); renderAll(true);
  });
  $('#size').oninput = (e) => { P.size = +e.target.value; document.documentElement.style.setProperty('--card-w', `${P.size}px`); };
  $('#size').onchange = savePrefs;
  $('#fit').onclick = () => { P.fit = P.fit === 'cover' ? 'contain' : 'cover'; $('#grid').classList.toggle('fit-contain', P.fit === 'contain'); savePrefs(); toast(P.fit === 'cover' ? '缩略图：裁切填充' : '缩略图：完整显示'); };
  $('#theme').onclick = () => { P.theme = P.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = P.theme; setThemeIcon(); savePrefs(); };

  $('#main').addEventListener('scroll', () => $('#filters').classList.toggle('stuck', $('#main').scrollTop > 60), { passive: true });

  // 面包屑 / 操作
  $('#crumbs').addEventListener('click', (e) => {
    if (e.target.closest('[data-favcur]')) return toggleFavDir(P.root, P.dir);
    const b = e.target.closest('[data-go]');
    if (b) navigate(b.dataset.go, b.dataset.dir);
  });
  $('#mactions').addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'rec') { P.rec = !P.rec; savePrefs(); renderHead(); loadItems(true); }
    if (a.dataset.act === 'scan') {
      const kind = P.mode;
      const run = scopeRoots().filter((r) => r.scans[kind].state !== 'running');
      if (!run.length) return;
      Promise.all(run.map((r) => post('/api/scan', { root: r.id, kind, action: 'start' }))).then(() => { toast(kind === 'image' ? '开始扫描图片' : '开始刷新'); return afterScanKick(); }).catch((er) => toast(er.message, true));
    }
  });
  $('#banner').addEventListener('click', (e) => bannerAction(e));
  $('#grid').addEventListener('click', (e) => {
    bannerAction(e);
    const fb = e.target.closest('[data-fav]');
    if (fb) { e.stopPropagation(); const host = fb.closest('[data-i]'); const it = S.items[+host.dataset.i]; if (it) toggleFavFile(it); return; }
    const fd = e.target.closest('[data-favdir]');
    if (fd) { e.stopPropagation(); const c = fd.closest('.fcard'); toggleFavDir(c.dataset.r, c.dataset.dir); return; }
    const fc = e.target.closest('.fcard');
    if (fc) { navigate(fc.dataset.r, fc.dataset.dir); return; }
    const host = e.target.closest('[data-i]');
    if (host) openViewer(+host.dataset.i);
  });
  bindHover($('#grid'));

  // 过滤
  $('#filters').addEventListener('click', (e) => {
    const c = e.target.closest('[data-f]'); if (!c) return;
    const v = c.dataset.v;
    switch (c.dataset.f) {
      case 'fav': S.favOnly = !S.favOnly; break;
      case 'favkind': P.favKind = v; savePrefs(); break;
      case 'group': P.group = v; savePrefs(); break;
      case 'type': S.types.has(v) ? S.types.delete(v) : S.types.add(v); break;
      case 'res': S.res.has(v) ? S.res.delete(v) : S.res.add(v); break;
      case 'clear': S.types.clear(); S.res.clear(); S.q = ''; $('#q').value = ''; break;
    }
    loadItems(true);
  });

  // 侧边栏树
  $('#tree').addEventListener('click', async (e) => {
    const node = e.target.closest('.tn'); if (!node) return;
    const { root, dir } = node.dataset;
    if (e.target.closest('[data-favnode]')) { e.stopPropagation(); return toggleFavDir(root, dir); }
    const arrow = e.target.closest('.tn-arrow');
    if (arrow && !arrow.classList.contains('none')) {
      const key = treeKey(root, dir);
      const open = !S.expanded.has(key);
      open ? S.expanded.add(key) : S.expanded.delete(key);
      arrow.classList.toggle('open', open);
      let kids = $(':scope > .tn-kids', node);
      if (!open) { if (kids) kids.remove(); } else if (!kids) { kids = el('div', 'tn-kids'); node.append(kids); fillKids(node, kids, root, dir); }
      savePrefs();
      return;
    }
    if (!root && !dir) return navigate('', '', { rebuildTree: false });
    navigate(root, dir, { rebuildTree: false });
    if (!S.expanded.has(treeKey(root, dir)) && !dir) { /* 根节点点击仅选中 */ }
  });
  $('#favDirs').addEventListener('click', (e) => {
    const n = e.target.closest('.tn'); if (!n) return;
    if (e.target.closest('[data-unfav]')) { e.stopPropagation(); return toggleFavDir(n.dataset.fr, n.dataset.fdir); }
    navigate(n.dataset.fr, n.dataset.fdir);
  });

  document.addEventListener('keydown', onKey);
  bindViewer();
}

function bannerAction(e) {
  const a = e.target.closest('[data-act]'); if (!a) return;
  const kind = P.mode;
  switch (a.dataset.act) {
    case 'scanun': startUnscanned(); break;
    case 'scan1': startScan(a.dataset.root, 'image'); break;
    case 'cancel': post('/api/scan', { kind, action: 'cancel', root: P.root || '' }).then(() => toast('已请求取消')); break;
    case 'admin': openAdmin(); break;
  }
}

function onKey(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
  if (!$('#admin').hidden) { if (e.key === 'Escape') closeAdmin(); return; }
  if (V.open) return viewerKey(e);
  if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); }
  else if (e.key === 'Escape' && typing) e.target.blur();
}

/* ═════════════ 查看器 ═════════════ */
const V = { open: false, i: -1, s: 1, fit: 1, x: 0, y: 0, rot: 0, nw: 0, nh: 0, slide: null, idle: null, info: false, tc: false, img: null, vid: null };

function bindViewer() {
  const vw = $('#viewer');
  $('#vClose').onclick = closeViewer;
  $('#vPrev').onclick = () => stepViewer(-1);
  $('#vNext').onclick = () => stepViewer(1);
  $('#vFav').onclick = () => { const it = S.items[V.i]; if (it) toggleFavFile(it); };
  $('#vInfo').onclick = toggleInfo;
  $('#vSlide').onclick = toggleSlide;
  $('#vFull').onclick = () => { document.fullscreenElement ? document.exitFullscreen() : vw.requestFullscreen && vw.requestFullscreen(); };
  vw.addEventListener('mousemove', bumpIdle);
  vw.addEventListener('click', (e) => { if (e.target === $('#vStage') && !$('#vStage').classList.contains('img')) return; });

  const stage = $('#vStage');
  stage.addEventListener('wheel', (e) => {
    if (!V.img) return;
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY);
  }, { passive: false });
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!V.img || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, ox: V.x, oy: V.y, moved: false };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('drag');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    V.x = drag.ox + dx; V.y = drag.oy + dy;
    applyImg();
  });
  const endDrag = () => { stage.classList.remove('drag'); drag = null; };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', (e) => {
    if (!V.img) return;
    if (Math.abs(V.s - V.fit) < 0.01) { zoomTo(Math.max(1, V.fit * 2), e.clientX, e.clientY); } else fitImg();
  });
  $('#vBottom').addEventListener('click', (e) => {
    const b = e.target.closest('[data-z]'); if (!b) return;
    const z = b.dataset.z;
    if (z === 'in') zoomAt(1.3); else if (z === 'out') zoomAt(1 / 1.3); else if (z === 'fit') fitImg(); else if (z === '1') zoomTo(1);
    else if (z === 'rl') rotate(-90); else if (z === 'rr') rotate(90);
  });
  $('#vBottom').addEventListener('change', (e) => {
    if (e.target.id === 'vRate') { P.rate = +e.target.value; savePrefs(); if (V.vid) V.vid.playbackRate = P.rate; }
    if (e.target.id === 'vAuto') { P.autoNext = e.target.checked; savePrefs(); }
  });
  window.addEventListener('resize', () => { if (V.open && V.img && Math.abs(V.s - V.fit) < 1e-6) fitImg(); });
  document.addEventListener('fullscreenchange', () => $('#vFull').classList.toggle('active', !!document.fullscreenElement));
}

function openViewer(i) {
  V.open = true;
  $('#viewer').hidden = false;
  document.body.style.overflow = 'hidden';
  endHover();
  showItem(i);
  bumpIdle();
}

function closeViewer() {
  if (!V.open) return;
  stopSlide();
  teardownMedia();
  V.open = false;
  $('#viewer').hidden = true;
  document.body.style.overflow = '';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (P.mode === 'fav') { /* 取消收藏的项在下次刷新时消失 */ }
}

function teardownMedia() {
  if (V.vid) { savePos(); V.vid.pause(); V.vid.removeAttribute('src'); V.vid.load(); V.vid = null; }
  V.img = null;
  $('#vStage').innerHTML = '';
  $('#vStage').classList.remove('img', 'drag');
}

function bumpIdle() {
  const vw = $('#viewer');
  vw.classList.remove('idle');
  clearTimeout(V.idle);
  V.idle = setTimeout(() => { if (V.open && $('#vInfoPane').hidden) vw.classList.add('idle'); }, 2600);
}

function updateViewerNav() {
  $('#vPrev').disabled = V.i <= 0;
  $('#vNext').disabled = V.i >= S.total - 1;
  $('#vCount').textContent = `${V.i + 1} / ${S.total}`;
}

function updateViewerFav() {
  const it = S.items[V.i];
  $('#vFav').classList.toggle('on', !!(it && it.f));
}

async function stepViewer(d) {
  let n = V.i + d;
  if (n < 0) return;
  if (n >= S.items.length) {
    if (S.items.length >= S.total) return;
    await loadItems(false);
    if (n >= S.items.length) return;
  }
  showItem(n);
}

async function showItem(i) {
  const it = S.items[i];
  if (!it) return;
  teardownMedia();
  V.i = i; V.tc = false;
  $('#viewer').classList.toggle('vid', it.k === 'video');
  $('#vTitle').textContent = it.n;
  $('#vSub').textContent = it.d || '（根目录）';
  $('#vSlide').style.display = it.k === 'image' ? '' : 'none';
  updateViewerNav();
  updateViewerFav();
  if (it.k === 'image') showImage(it); else showVideo(it);
  if ($('#vInfoPane').hidden === false) renderInfo(it);
  // 预加载相邻图片
  for (const j of [i + 1, i - 1]) {
    const o = S.items[j];
    if (o && o.k === 'image') { const im = new Image(); im.src = fileUrl(o); }
  }
  if (i >= S.items.length - 4 && S.items.length < S.total) loadItems(false);
}

function showImage(it) {
  const stage = $('#vStage');
  stage.classList.add('img');
  stage.innerHTML = '<div class="spin" style="position:absolute;left:50%;top:50%;margin:-8px 0 0 -8px"></div>';
  const img = new Image();
  img.className = 'vimg';
  img.draggable = false;
  img.onload = () => {
    if (V.i < 0 || S.items[V.i] !== it) return;
    stage.innerHTML = '';
    stage.append(img);
    V.img = img; V.nw = img.naturalWidth; V.nh = img.naturalHeight; V.rot = 0;
    img.style.width = `${V.nw}px`; img.style.height = `${V.nh}px`;
    fitImg();
    if (!it.w) { it.w = V.nw; it.h = V.nh; }
  };
  img.onerror = () => { stage.innerHTML = `<div class="verr"><p>这张图片无法在浏览器中显示（格式不受支持或文件已损坏）。</p></div>`; };
  img.src = fileUrl(it);
  $('#vBottom').innerHTML =
    `<button data-z="rl" title="向左旋转">↺</button><button data-z="rr" title="向右旋转">↻</button><span style="width:1px;height:18px;background:rgba(255,255,255,.15)"></span>` +
    `<button data-z="out" title="缩小 (-)">−</button><span class="zl" id="zl">100%</span><button data-z="in" title="放大 (+)">＋</button>` +
    `<button data-z="fit" title="适应屏幕 (0)">适应</button><button data-z="1" title="原始大小 (1)">1:1</button>`;
}

function stageSize() {
  const r = $('#vStage').getBoundingClientRect();
  return { w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
}
function applyImg() {
  if (!V.img) return;
  V.img.style.transform = `translate(-50%,-50%) translate(${V.x}px,${V.y}px) rotate(${V.rot}deg) scale(${V.s})`;
  const zl = $('#zl');
  if (zl) zl.textContent = `${Math.round(V.s * 100)}%`;
}
function fitImg() {
  const st = stageSize();
  const swap = V.rot % 180 !== 0;
  const w = swap ? V.nh : V.nw, h = swap ? V.nw : V.nh;
  V.fit = Math.min(st.w / w, st.h / h, 1);
  V.s = V.fit; V.x = 0; V.y = 0;
  applyImg();
}
function zoomTo(s, cx, cy) { zoomAt(s / V.s, cx, cy); }
function zoomAt(f, cx, cy) {
  if (!V.img) return;
  const st = stageSize();
  const px = (cx == null ? st.cx : cx) - st.cx, py = (cy == null ? st.cy : cy) - st.cy;
  const ns = Math.min(40, Math.max(0.05, V.s * f));
  const k = ns / V.s;
  V.x = px - (px - V.x) * k;
  V.y = py - (py - V.y) * k;
  V.s = ns;
  applyImg();
}
function rotate(d) {
  V.rot = (V.rot + d + 360) % 360;
  fitImg();
}

/* 视频 */
const posKey = (it) => `${it.r}|${it.p}`;
function savePos() {
  const v = V.vid, it = S.items[V.i];
  if (!v || !it || !v.duration || v.duration < 90) return;
  const m = lsGet(POS_KEY, {});
  const k = posKey(it);
  if (v.currentTime > 5 && v.currentTime < v.duration - 8) { delete m[k]; m[k] = Math.floor(v.currentTime); } else delete m[k];
  const keys = Object.keys(m);
  if (keys.length > 200) for (const old of keys.slice(0, keys.length - 200)) delete m[old];
  lsSet(POS_KEY, m);
}

function showVideo(it) {
  const stage = $('#vStage');
  const v = document.createElement('video');
  v.controls = true; v.autoplay = true; v.playsInline = true;
  v.volume = P.vol; v.muted = P.muted;
  v.src = fileUrl(it);
  v.addEventListener('loadedmetadata', () => {
    v.playbackRate = P.rate;
    reportDim(it, v);
    if (!it.t && isFinite(v.duration)) it.t = v.duration;
    const saved = lsGet(POS_KEY, {})[posKey(it)];
    if (saved && !V.tc && saved < v.duration - 8) { v.currentTime = saved; toast(`从 ${fmtDur(saved)} 继续播放`); }
  });
  let last = 0;
  v.addEventListener('timeupdate', () => { if (Date.now() - last > 4000) { last = Date.now(); savePos(); } });
  v.addEventListener('volumechange', () => { P.vol = v.volume; P.muted = v.muted; savePrefs(); });
  v.addEventListener('ended', () => {
    const m = lsGet(POS_KEY, {}); delete m[posKey(it)]; lsSet(POS_KEY, m);
    if (P.autoNext && V.i < S.total - 1) stepViewer(1);
  });
  v.addEventListener('error', () => videoError(it, v));
  stage.append(v);
  V.vid = v;
  $('#vBottom').innerHTML =
    `<select id="vRate" title="播放速度">${[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => `<option value="${r}"${r === P.rate ? ' selected' : ''}>${r}x</option>`).join('')}</select>` +
    `<label><input type="checkbox" id="vAuto"${P.autoNext ? ' checked' : ''}>连播</label>`;
  v.play().catch(() => {});
}

function videoError(it, v) {
  const stage = $('#vStage');
  if (stage.querySelector('.verr')) return;
  const canTc = caps().ffmpeg && !V.tc;
  const box = el('div', 'verr', `<div class="empty-ic" style="background:rgba(255,255,255,.08);color:#fff">${icon('alert')}</div>
    <h3 style="margin:0">浏览器无法直接播放这个视频</h3>
    <p>${V.tc ? '转码播放也失败了，请检查 ffmpeg 是否正常。' : `${esc(it.e.toUpperCase())} 封装或其中的编码（如 HEVC / AVI / WMV）不被当前浏览器支持。`}${canTc ? '可以用本机 ffmpeg 实时转码为 H.264 播放（不支持拖动进度条）。' : V.tc ? '' : '安装 ffmpeg 后即可使用转码播放。'}</p>
    ${canTc ? '<button class="btn primary" id="tcBtn">转码播放</button>' : ''}`);
  stage.append(box);
  const b = $('#tcBtn', box);
  if (b) b.onclick = () => { V.tc = true; box.remove(); v.src = transcodeUrl(it); v.play().catch(() => {}); };
}

/* 幻灯片 */
function toggleSlide() { V.slide ? stopSlide() : startSlide(); }
function startSlide() {
  stopSlide();
  $('#vSlide').classList.add('active');
  $('#vSlide').innerHTML = icon('pause');
  V.slide = setInterval(async () => {
    const it = S.items[V.i];
    if (it && it.k === 'image') {
      if (V.i >= S.total - 1) showItem(0); else await stepViewer(1);
    }
  }, 3500);
}
function stopSlide() {
  clearInterval(V.slide); V.slide = null;
  const b = $('#vSlide');
  b.classList.remove('active');
  b.innerHTML = icon('play');
}

/* 详情 */
function toggleInfo() {
  const pane = $('#vInfoPane');
  pane.hidden = !pane.hidden;
  $('#vInfo').classList.toggle('active', !pane.hidden);
  if (!pane.hidden) renderInfo(S.items[V.i]);
  bumpIdle();
}
function renderInfo(it) {
  if (!it) return;
  const root = rootById(it.r);
  const sep = S.info.platform === 'win32' ? '\\' : '/';
  const full = root ? root.path.replace(/[\\/]+$/, '') + sep + it.p.split('/').join(sep) : it.p;
  $('#vInfoPane').innerHTML = `<h4>${esc(it.n)}</h4><dl>
    <dt>类型</dt><dd>${esc(it.e.toUpperCase())} · ${it.k === 'video' ? '视频' : '图片'}</dd>
    <dt>分辨率</dt><dd>${it.w ? `${it.w} × ${it.h}（${RES_LABEL[it.b]}）` : '未知'}</dd>
    <dt>大小</dt><dd>${fmtSize(it.s)}</dd>
    ${it.t ? `<dt>时长</dt><dd>${fmtDur(it.t)}</dd>` : ''}
    <dt>修改</dt><dd>${fmtDate(it.m)}</dd>
    <dt>来源</dt><dd>${esc(root ? root.name : '')}</dd>
    <dt>路径</dt><dd>${esc(full)}</dd></dl>
    <button class="btn" id="copyPath">${icon('copy')}复制路径</button>`;
  $('#copyPath').onclick = () => navigator.clipboard.writeText(full).then(() => toast('路径已复制'), () => toast('复制失败', true));
}

function viewerKey(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'select' || (tag === 'input' && e.target.type !== 'checkbox')) return;
  const it = S.items[V.i];
  const k = e.key;
  bumpIdle();
  if (k === 'Escape') { if (!$('#vInfoPane').hidden) toggleInfo(); else if (!document.fullscreenElement) closeViewer(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const isImg = it && it.k === 'image';
  if (k === 'ArrowRight' && isImg) { stepViewer(1); e.preventDefault(); }
  else if (k === 'ArrowLeft' && isImg) { stepViewer(-1); e.preventDefault(); }
  else if (k === 'PageDown' || k === 'n' || k === 'N') { stepViewer(1); e.preventDefault(); }
  else if (k === 'PageUp' || k === 'p' || k === 'P') { stepViewer(-1); e.preventDefault(); }
  else if (k === 'f' || k === 'F') { if (it) toggleFavFile(it); }
  else if (k === 'i' || k === 'I') toggleInfo();
  else if (isImg) {
    if (k === ' ') { toggleSlide(); e.preventDefault(); }
    else if (k === '+' || k === '=') zoomAt(1.3);
    else if (k === '-') zoomAt(1 / 1.3);
    else if (k === '0') fitImg();
    else if (k === '1') zoomTo(1);
    else if (k === 'r') rotate(90);
    else if (k === 'R') rotate(-90);
  } else if (V.vid) {
    const v = V.vid;
    if (k === ' ' && tag !== 'video') { v.paused ? v.play() : v.pause(); e.preventDefault(); }
    else if (k === 'ArrowRight') { v.currentTime = Math.min(v.duration || 1e9, v.currentTime + (e.shiftKey ? 30 : 5)); e.preventDefault(); }
    else if (k === 'ArrowLeft') { v.currentTime = Math.max(0, v.currentTime - (e.shiftKey ? 30 : 5)); e.preventDefault(); }
    else if (k === 'ArrowUp') { v.volume = Math.min(1, v.volume + 0.1); e.preventDefault(); }
    else if (k === 'ArrowDown') { v.volume = Math.max(0, v.volume - 0.1); e.preventDefault(); }
    else if (k === 'm' || k === 'M') v.muted = !v.muted;
    else if (k === ']' || k === '[') {
      const rates = [0.5, 0.75, 1, 1.25, 1.5, 2];
      const idx = Math.max(0, Math.min(rates.length - 1, rates.indexOf(P.rate) + (k === ']' ? 1 : -1)));
      P.rate = rates[idx]; v.playbackRate = P.rate; const sel = $('#vRate'); if (sel) sel.value = P.rate; savePrefs(); toast(`速度 ${P.rate}x`);
    }
  }
}

/* ═════════════ 后台管理 ═════════════ */
const AD = { pick: null, pickOpen: false };

function openAdmin(focusAdd) {
  $('#admin').hidden = false;
  renderAdmin();
  if (focusAdd === true) setTimeout(() => { const i = $('#addPath'); if (i) i.focus(); }, 50);
}
function closeAdmin() {
  $('#admin').hidden = true;
  refreshRoots().then(() => { renderTree(); renderBanner(); });
}

function rootStat(r, kind) {
  const s = r.scans[kind];
  const label = kind === 'image' ? '图片' : '视频';
  const st = s.state === 'running' ? `<span class="spin"></span>扫描中 ${s.found}` : s.state === 'none' ? '未扫描' : `${s.count} ${kind === 'image' ? '张' : '个'}${s.updatedAt ? ` · ${ago(s.updatedAt)}` : ''}`;
  return `<span>${icon(kind)}${label}：${st}</span>`;
}

function renderAdminRoots() {
  const host = $('#adminRoots');
  if (!host) return;
  if (!S.roots.length) { host.innerHTML = '<div class="hint">还没有媒体路径，在下方添加第一个吧。</div>'; return; }
  host.innerHTML = S.roots.map((r) => `<div class="rootitem" data-id="${r.id}">
    <div class="rico${r.exists ? '' : ' bad'}">${icon('folder')}</div>
    <div class="rmain"><b>${esc(r.name)} <span class="pill ${r.exists ? 'ok' : 'bad'}">${r.exists ? '可访问' : '路径失效'}</span></b><small title="${esc(r.path)}">${esc(r.path)}</small>
      <div class="rstat">${rootStat(r, 'video')}${rootStat(r, 'image')}</div></div>
    <div class="racts">
      <button class="btn sm" data-a="scan-video">${icon('refresh')}视频</button>
      <button class="btn sm" data-a="scan-image">${icon('scan')}图片</button>
      <button class="btn sm" data-a="rename">${icon('edit')}</button>
      <button class="btn sm danger" data-a="del">${icon('trash')}</button>
    </div></div>`).join('');
}

function renderAdmin() {
  const cp = caps();
  $('#adminBody').innerHTML = `
    <div class="sec-t">媒体源（已添加的路径）</div>
    <div class="rootlist" id="adminRoots"></div>
    <div class="sec-t">添加路径</div>
    <div class="addrow">
      <input class="input" id="addPath" placeholder="粘贴本机文件夹路径，如 D:\\Videos 或 /Users/me/Pictures" spellcheck="false">
      <input class="input" id="addName" placeholder="显示名称（可选）">
      <button class="btn" id="btnBrowse">${icon('folder')}浏览…</button>
    </div>
    <div style="margin-top:10px;display:flex;gap:10px;align-items:center">
      <button class="btn primary" id="btnAdd">${icon('plus')}添加到媒体库</button>
      <span class="hint" style="margin:0">添加后视频会自动扫描；图片需要在「图片」页手动点击开始扫描。</span>
    </div>
    <div class="picker" id="picker" hidden></div>
    <div class="sec-t">运行环境</div>
    <div class="sysgrid">
      <div class="sysitem"><b><span class="dot ${cp.ffmpeg ? 'ok' : ''}"></span>ffmpeg</b><small>${cp.ffmpeg ? '已检测到：生成缩略图、转码播放（MKV/AVI/HEVC 等）' : '未检测到：缩略图使用原图 / 浏览器抽帧，无法转码'}</small></div>
      <div class="sysitem"><b><span class="dot ${cp.ffprobe ? 'ok' : ''}"></span>ffprobe</b><small>${cp.ffprobe ? '已检测到：可解析全部视频格式的分辨率与时长' : '未检测到：仅 MP4/MOV 能解析分辨率，其它格式在播放过一次后记录'}</small></div>
      <div class="sysitem"><b><span class="dot ok"></span>数据目录</b><small>${esc(S.info.dataDir)}</small></div>
    </div>`;
  renderAdminRoots();
}

async function loadPicker(p) {
  try {
    AD.pick = await api(`/api/browse?path=${encodeURIComponent(p || '')}`);
    if (!p && AD.pick.places.length) return loadPicker(AD.pick.places[0].path);
    renderPicker();
  } catch (e) { toast(e.message, true); }
}

function renderPicker() {
  const box = $('#picker');
  if (!box) return;
  const d = AD.pick;
  box.hidden = false;
  box.innerHTML = `<div class="picker-bar">
      <button class="btn sm" data-p="up" ${d.parent == null ? 'disabled' : ''}>${icon('up')}上一级</button>
      <input class="input" id="pickPath" value="${esc(d.path)}" placeholder="选择下方位置，或直接输入路径后回车">
      <button class="btn sm" data-p="close">${icon('close')}</button></div>
    <div class="places">${d.places.map((x) => `<button class="chip" data-p="go" data-path="${esc(x.path)}">${esc(x.name)}</button>`).join('')}</div>
    <div class="picker-list">${d.entries.length ? d.entries.map((x) => `<div class="prow" data-p="go" data-path="${esc(x.path)}">${icon('folder')}<span>${esc(x.name)}</span></div>`).join('') : `<div class="hint" style="padding:10px">${d.path ? '没有子文件夹' : '从上方选择一个位置开始'}</div>`}</div>
    <div class="picker-foot"><code>${esc(d.path || '未选择')}</code><button class="btn sm primary" data-p="choose" ${d.path ? '' : 'disabled'}>${icon('check')}选择此文件夹</button></div>`;
}

document.addEventListener('click', async (e) => {
  const adm = e.target.closest('#admin');
  if (!adm) return;
  if (e.target === $('#admin')) return closeAdmin();
  if (e.target.closest('#adminClose')) return closeAdmin();

  if (e.target.closest('#btnBrowse')) { AD.pickOpen = true; return loadPicker($('#addPath').value.trim() || ''); }
  const pk = e.target.closest('[data-p]');
  if (pk) {
    const a = pk.dataset.p;
    if (a === 'go') return loadPicker(pk.dataset.path);
    if (a === 'up') return loadPicker(AD.pick.parent);
    if (a === 'close') { $('#picker').hidden = true; return; }
    if (a === 'choose') {
      $('#addPath').value = AD.pick.path;
      $('#picker').hidden = true;
      $('#addName').focus();
      return;
    }
  }
  if (e.target.closest('#btnAdd')) {
    const path = $('#addPath').value.trim(), name = $('#addName').value.trim();
    try {
      const r = await post('/api/roots', { path, name });
      toast(`已添加「${r.name}」`);
      $('#addPath').value = ''; $('#addName').value = '';
      await refreshRoots();
      renderAdminRoots();
      renderTree();
      post('/api/scan', { root: r.id, kind: 'video', action: 'start' }).then(() => afterScanKick());
    } catch (er) { toast(er.message, true); }
    return;
  }
  const item = e.target.closest('.rootitem');
  const act = e.target.closest('[data-a]');
  if (item && act) {
    const id = item.dataset.id, root = rootById(id);
    try {
      if (act.dataset.a === 'scan-video' || act.dataset.a === 'scan-image') {
        await post('/api/scan', { root: id, kind: act.dataset.a === 'scan-image' ? 'image' : 'video', action: 'start' });
        await sleep(100); await refreshRoots(); ensurePolling(); renderAdminRoots(); toast('已开始扫描');
      } else if (act.dataset.a === 'rename') {
        const name = prompt('新的显示名称', root.name);
        if (name && name.trim()) { await api(`/api/roots/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }); await refreshRoots(); await refreshFavDirs(); renderAdminRoots(); renderTree(); renderHead(); }
      } else if (act.dataset.a === 'del') {
        if (!confirm(`从媒体库移除「${root.name}」？\n只会删除索引和该源下的收藏记录，不会删除磁盘上的任何文件。`)) return;
        await api(`/api/roots/${id}`, { method: 'DELETE' });
        if (P.root === id) { P.root = ''; P.dir = ''; }
        await refreshRoots(); await refreshFavDirs(); renderAdminRoots(); renderTree(); renderHead(); loadItems(true);
        toast('已移除');
      }
    } catch (er) { toast(er.message, true); }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'pickPath') loadPicker(e.target.value.trim());
  if (e.key === 'Enter' && (e.target.id === 'addPath' || e.target.id === 'addName')) $('#btnAdd').click();
});

boot();
})();
