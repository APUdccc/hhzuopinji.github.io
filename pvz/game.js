/* 植物大战僵尸 · 网页复刻版
 * 所有画面均使用 Canvas 2D 原创绘制，无外部图片素材。 */
(() => {
'use strict';

// ======================================================================
// 基础常量与工具
// ======================================================================
const W = 1280, H = 720;
const G = { x: 240, y: 140, cw: 100, ch: 114, cols: 9, rows: 5 };
const FONT = '"ZCOOL KuaiLe","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
const TAU = Math.PI * 2;
const SUN_POS = { x: 56, y: 46 };

const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutBack = t => { const c = 1.7; t -= 1; return 1 + (c + 1) * t * t * t + c * t * t; };
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function rowBase(r) { return G.y + r * G.ch + G.ch - 16; }
function colCenter(c) { return G.x + c * G.cw + G.cw / 2; }

function mulberry32(a) {
    return () => {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// ---- 颜色 ----
const _rgb = new Map();
function rgb(h) {
    let v = _rgb.get(h);
    if (!v) { const n = parseInt(h.slice(1), 16); v = [n >> 16 & 255, n >> 8 & 255, n & 255]; _rgb.set(h, v); }
    return v;
}
const _mix = new Map();
function mix(a, b, t) {
    const k = a + b + t;
    let v = _mix.get(k);
    if (v) return v;
    const A = rgb(a), B = rgb(b);
    v = '#' + A.map((x, i) => Math.round(x + (B[i] - x) * t).toString(16).padStart(2, '0')).join('');
    _mix.set(k, v);
    return v;
}
const lighten = (h, t) => mix(h, '#ffffff', t);
const darken = (h, t) => mix(h, '#000000', t);
function rgba(h, a) { const c = rgb(h); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; }

// ---- 路径 ----
function rrect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
}
function ell(c, x, y, rx, ry, rot = 0) { c.beginPath(); c.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), rot, 0, TAU); }
function circ(c, x, y, r) { c.beginPath(); c.arc(x, y, Math.max(0.01, r), 0, TAU); }
function fs(c, fill, stroke, lw = 2) {
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.lineWidth = lw; c.strokeStyle = stroke; c.stroke(); }
}
function rad(c, x, y, r, stops, ox = -0.35, oy = -0.4) {
    const g = c.createRadialGradient(x + r * ox, y + r * oy, r * 0.05, x, y, r);
    stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
    return g;
}
function lin(c, x0, y0, x1, y1, stops) {
    const g = c.createLinearGradient(x0, y0, x1, y1);
    stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
    return g;
}
function leaf(c, x0, y0, x1, y1, w, col, dark) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L * w, ny = dx / L * w, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    c.beginPath();
    c.moveTo(x0, y0);
    c.quadraticCurveTo(mx + nx, my + ny, x1, y1);
    c.quadraticCurveTo(mx - nx, my - ny, x0, y0);
    c.closePath();
    c.fillStyle = lin(c, mx + nx, my + ny, mx - nx, my - ny, [lighten(col, 0.25), col, darken(col, 0.12)]);
    c.fill();
    c.lineWidth = 1.8; c.strokeStyle = dark; c.stroke();
    c.beginPath();
    c.moveTo(x0, y0);
    c.quadraticCurveTo(mx + nx * 0.15, my + ny * 0.15, x0 + dx * 0.85, y0 + dy * 0.85);
    c.lineWidth = 1.1; c.strokeStyle = rgba(dark, 0.55); c.stroke();
}
function stem(c, pts, col, dark, w) {
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
        c.beginPath();
        c.moveTo(pts[0], pts[1]);
        if (pts.length === 6) c.quadraticCurveTo(pts[2], pts[3], pts[4], pts[5]);
        else c.bezierCurveTo(pts[2], pts[3], pts[4], pts[5], pts[6], pts[7]);
        c.strokeStyle = pass ? col : dark;
        c.lineWidth = pass ? w - 3.5 : w;
        c.stroke();
    }
}
function eye(c, x, y, rx, ry, px, py, pr, blink = 0, white = '#ffffff', line = '#1b1b1b') {
    ell(c, x, y, rx, ry * (1 - blink * 0.9));
    fs(c, white, line, 1.6);
    if (blink < 0.6) {
        circ(c, px, py, pr); fs(c, '#141414');
        circ(c, px - pr * 0.35, py - pr * 0.45, pr * 0.38); fs(c, '#ffffff');
    }
}

// ======================================================================
// 音效（WebAudio 合成）
// ======================================================================
const SFX = (() => {
    let ac = null, master = null, muted = false, nbuf = null;
    const last = {};
    function init() {
        try {
            if (!ac) {
                ac = new (window.AudioContext || window.webkitAudioContext)();
                master = ac.createGain(); master.gain.value = 0.45; master.connect(ac.destination);
                nbuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
                const d = nbuf.getChannelData(0);
                for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
            }
            if (ac.state === 'suspended') ac.resume();
        } catch (e) { ac = null; }
    }
    function ok(name, gap) {
        if (!ac || muted) return false;
        if (!name) return true;
        const n = performance.now();
        if (last[name] && n - last[name] < gap) return false;
        last[name] = n;
        return true;
    }
    function tone(f, d, type = 'sine', v = 0.2, f2 = null, delay = 0) {
        if (!ac || muted) return;
        const t = ac.currentTime + delay;
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f, t);
        if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(v, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g); g.connect(master);
        o.start(t); o.stop(t + d + 0.05);
    }
    function noise(d, v = 0.2, freq = 1000, ft = 'lowpass', delay = 0) {
        if (!ac || muted) return;
        const t = ac.currentTime + delay;
        const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
        s.buffer = nbuf; f.type = ft; f.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(v, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        s.connect(f); f.connect(g); g.connect(master);
        s.start(t, Math.random()); s.stop(t + d + 0.05);
    }
    return {
        init,
        get muted() { return muted; },
        set muted(v) { muted = v; },
        plant() { if (!ok('plant', 50)) return; noise(0.2, 0.4, 450); tone(190, 0.16, 'triangle', 0.25, 70); },
        shoot() { if (!ok('shoot', 45)) return; tone(560, 0.07, 'square', 0.035, 240); noise(0.05, 0.06, 2600, 'bandpass'); },
        hit() { if (!ok('hit', 35)) return; noise(0.09, 0.16, 1300, 'bandpass'); tone(210, 0.07, 'sine', 0.1, 110); },
        metal() { if (!ok('metal', 70)) return; tone(1650, 0.2, 'triangle', 0.06, 1480); tone(2480, 0.14, 'sine', 0.04); },
        plastic() { if (!ok('plastic', 70)) return; tone(700, 0.08, 'triangle', 0.08, 500); noise(0.05, 0.08, 1800, 'bandpass'); },
        sun() { if (!ok('sun', 40)) return; tone(880, 0.12, 'sine', 0.16); tone(1320, 0.2, 'sine', 0.13, null, 0.07); },
        pick() { if (!ok('pick', 30)) return; tone(620, 0.07, 'triangle', 0.12, 820); },
        deny() { if (!ok('deny', 120)) return; tone(170, 0.16, 'square', 0.05, 120); },
        chomp() { if (!ok('chomp', 110)) return; noise(0.06, 0.2, 900); noise(0.05, 0.15, 650, 'lowpass', 0.09); },
        gulp() { if (!ok('gulp', 200)) return; tone(320, 0.28, 'sine', 0.25, 80); },
        boom() { if (!ok('boom', 80)) return; noise(1.1, 0.8, 650); tone(95, 0.7, 'sine', 0.5, 28); noise(0.35, 0.35, 3200, 'highpass'); },
        siren() { if (!ok()) return; for (let i = 0; i < 3; i++) { tone(400, 0.38, 'sawtooth', 0.05, 760, i * 0.76); tone(760, 0.38, 'sawtooth', 0.05, 400, i * 0.76 + 0.38); } },
        groan() { if (!ok('groan', 4200)) return; const f = rand(85, 115); tone(f, 1.2, 'sawtooth', 0.045, f * 0.68); tone(f * 1.5, 1.0, 'triangle', 0.03, f); },
        mower() { if (!ok('mower', 300)) return; noise(1.4, 0.22, 320); tone(68, 1.4, 'sawtooth', 0.07, 96); },
        win() { if (!ok()) return; [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.35, 'triangle', 0.18, null, i * 0.12)); tone(1047, 0.9, 'sine', 0.14, null, 0.65); },
        lose() { if (!ok()) return; [392, 330, 262, 196, 147].forEach((f, i) => tone(f, 0.5, 'sawtooth', 0.06, null, i * 0.32)); },
        shovel() { if (!ok('shovel', 80)) return; noise(0.18, 0.3, 900); tone(240, 0.1, 'triangle', 0.12, 120); },
        ready() { if (!ok()) return; tone(660, 0.18, 'triangle', 0.15); },
        go() { if (!ok()) return; tone(523, 0.12, 'triangle', 0.15); tone(784, 0.3, 'triangle', 0.18, null, 0.1); },
        pop() { if (!ok('pop', 60)) return; tone(380, 0.12, 'sine', 0.14, 900); },
        arm() { if (!ok('arm', 100)) return; noise(0.2, 0.2, 500); tone(300, 0.15, 'sine', 0.12, 600, 0.05); },
    };
})();

// ======================================================================
// 植物 / 僵尸 / 关卡数据
// ======================================================================
const PT = {
    sunflower: { name: '向日葵', cost: 50, cd: 7.5, hp: 300, desc: '生产额外的阳光' },
    peashooter: { name: '豌豆射手', cost: 100, cd: 7.5, hp: 300, desc: '向前发射豌豆' },
    snowpea: { name: '寒冰射手', cost: 175, cd: 7.5, hp: 300, desc: '冰豌豆可减速僵尸' },
    repeater: { name: '双发射手', cost: 200, cd: 7.5, hp: 300, desc: '一次发射两颗豌豆' },
    wallnut: { name: '坚果墙', cost: 50, cd: 30, hp: 4000, desc: '坚硬的外壳挡住僵尸' },
    potatomine: { name: '土豆地雷', cost: 25, cd: 30, hp: 300, desc: '埋好后触碰即爆炸' },
    cherrybomb: { name: '樱桃炸弹', cost: 150, cd: 50, hp: 9999, desc: '炸飞周围一片僵尸' },
    chomper: { name: '大嘴花', cost: 150, cd: 7.5, hp: 300, desc: '一口吞掉整只僵尸' },
};

const ZT = {
    normal: { name: '普通僵尸', hp: 270, armor: 0, speed: [13.5, 17], cost: 1, weight: 10, minWave: 1 },
    flag: { name: '旗帜僵尸', hp: 270, armor: 0, speed: [21, 23], cost: 1, weight: 0, minWave: 99 },
    cone: { name: '路障僵尸', hp: 270, armor: 370, armorType: 'cone', speed: [13.5, 17], cost: 2, weight: 7, minWave: 2 },
    bucket: { name: '铁桶僵尸', hp: 270, armor: 1100, armorType: 'bucket', speed: [13.5, 17], cost: 4, weight: 4, minWave: 3 },
    football: { name: '橄榄球僵尸', hp: 270, armor: 1400, armorType: 'helmet', speed: [34, 40], cost: 7, weight: 2, minWave: 4 },
};

const ALL_PLANTS = ['sunflower', 'peashooter', 'snowpea', 'repeater', 'wallnut', 'potatomine', 'cherrybomb', 'chomper'];
const LEVELS = [
    { name: '初来乍到', plants: ['sunflower', 'peashooter', 'wallnut'], zombies: ['normal'], waves: 6, huge: [6], base: 0.6, grow: 0.45, sun: 50, first: 26, featP: 'peashooter', featZ: 'normal', note: '豌豆射手 · 坚果墙' },
    { name: '路障来袭', plants: ['sunflower', 'peashooter', 'wallnut', 'potatomine', 'cherrybomb'], zombies: ['normal', 'cone'], waves: 10, huge: [10], base: 0.8, grow: 0.55, sun: 50, first: 24, featP: 'cherrybomb', featZ: 'cone', note: '樱桃炸弹 · 土豆地雷' },
    { name: '寒冰时刻', plants: ['sunflower', 'peashooter', 'snowpea', 'wallnut', 'potatomine', 'cherrybomb'], zombies: ['normal', 'cone', 'bucket'], waves: 12, huge: [6, 12], base: 1, grow: 0.62, sun: 75, first: 22, featP: 'snowpea', featZ: 'bucket', note: '寒冰射手 · 铁桶僵尸' },
    { name: '全力冲锋', plants: ALL_PLANTS, zombies: ['normal', 'cone', 'bucket', 'football'], waves: 15, huge: [8, 15], base: 1.1, grow: 0.7, sun: 100, first: 22, featP: 'chomper', featZ: 'football', note: '大嘴花 · 双发射手' },
    { name: '最终防线', plants: ALL_PLANTS, zombies: ['normal', 'cone', 'bucket', 'football'], waves: 20, huge: [10, 20], base: 1.3, grow: 0.78, sun: 150, first: 20, featP: 'repeater', featZ: 'flag', note: '终极挑战 · 20 波' },
];

// ======================================================================
// 画布与缩放
// ======================================================================
const stage = document.getElementById('stage');
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let S = 1, bg = null;

function resize() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const k = Math.min(vw / W, vh / H);
    const cw = Math.floor(W * k), chh = Math.floor(H * k);
    stage.style.width = cw + 'px';
    stage.style.height = chh + 'px';
    stage.style.fontSize = (16 * k) + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    S = k * dpr;
    canvas.width = Math.round(W * S);
    canvas.height = Math.round(H * S);
    bg = buildBackground();
    const rot = document.getElementById('rotate');
    rot.classList.toggle('on', vh > vw && !rot.dataset.off);
}

// ======================================================================
// 背景（预渲染）
// ======================================================================
function buildBackground() {
    const cv = document.createElement('canvas');
    cv.width = canvas.width; cv.height = canvas.height;
    const c = cv.getContext('2d');
    c.scale(S, S);
    const R = mulberry32(20240607);
    const rr = (a, b) => a + R() * (b - a);

    // 天空
    c.fillStyle = lin(c, 0, 0, 0, 150, ['#6cc0f0', '#bfe8fb', '#e8f8ff']);
    c.fillRect(0, 0, W, 150);
    // 云
    for (let i = 0; i < 7; i++) {
        const x = rr(150, W), y = rr(18, 70), s = rr(0.6, 1.2);
        c.fillStyle = 'rgba(255,255,255,.85)';
        for (let j = 0; j < 5; j++) { circ(c, x + (j - 2) * 22 * s, y + Math.abs(j - 2) * 5 * s, (24 - Math.abs(j - 2) * 5) * s); c.fill(); }
    }
    // 远处树林
    for (let layer = 0; layer < 2; layer++) {
        const col = layer ? '#3c8a33' : '#5aa548';
        c.fillStyle = col;
        c.beginPath();
        c.moveTo(0, 150);
        for (let x = 0; x <= W + 40; x += 30) {
            const y = (layer ? 108 : 92) + Math.sin(x * 0.05 + layer * 2) * 8 + rr(-6, 6);
            c.quadraticCurveTo(x - 15, y - rr(10, 22), x, y);
        }
        c.lineTo(W, 150); c.closePath(); c.fill();
    }
    // 草坪底色
    c.fillStyle = '#5da832';
    c.fillRect(0, G.y - 8, W, H - G.y + 8);

    // 割草机道
    for (let r = 0; r < G.rows; r++) {
        c.fillStyle = r % 2 ? '#62a83a' : '#6bb341';
        c.fillRect(150, G.y + r * G.ch, G.x - 150, G.ch);
    }
    // 草坪格子
    for (let r = 0; r < G.rows; r++) {
        for (let col = 0; col < G.cols; col++) {
            const light = (r + col) % 2 === 0;
            const base = light ? '#7cc84a' : '#6dba3d';
            const x = G.x + col * G.cw, y = G.y + r * G.ch;
            c.fillStyle = lin(c, x, y, x, y + G.ch, [lighten(base, 0.06), base, darken(base, 0.05)]);
            c.fillRect(x, y, G.cw, G.ch);
        }
    }
    // 草叶纹理
    const blades = ['#8fd65a', '#5aa62f', '#9be064', '#4f9a2a', '#7cc84a'];
    for (let i = 0; i < 7000; i++) {
        const x = rr(150, 1140), y = rr(G.y, H - 10);
        const L = rr(3, 8), a = -Math.PI / 2 + rr(-0.5, 0.5);
        c.strokeStyle = rgba(blades[i % blades.length], rr(0.25, 0.55));
        c.lineWidth = rr(0.8, 1.6);
        c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); c.stroke();
    }
    // 小花
    for (let i = 0; i < 46; i++) {
        const x = rr(160, 1130), y = rr(G.y + 10, H - 16);
        const col = pick(['#ffffff', '#fff27a', '#f6b4ff', '#ffd1e0']);
        for (let k = 0; k < 5; k++) {
            const a = k / 5 * TAU;
            circ(c, x + Math.cos(a) * 2.6, y + Math.sin(a) * 2.6, 2); fs(c, col);
        }
        circ(c, x, y, 1.6); fs(c, '#f5a300');
    }
    // 行分割柔光
    for (let r = 1; r < G.rows; r++) {
        c.fillStyle = 'rgba(0,40,0,.06)';
        c.fillRect(150, G.y + r * G.ch - 1, 990, 2);
    }
    // 栅栏阴影
    c.fillStyle = lin(c, 0, G.y - 8, 0, G.y + 26, ['rgba(20,50,10,.38)', 'rgba(20,50,10,0)']);
    c.fillRect(150, G.y - 8, 1040, 34);

    // 白色尖桩栅栏
    for (let x = 160; x < 1150; x += 24) {
        c.save(); c.translate(x, 0);
        c.beginPath(); c.moveTo(0, 144); c.lineTo(0, 98); c.lineTo(8, 88); c.lineTo(16, 98); c.lineTo(16, 144); c.closePath();
        c.fillStyle = lin(c, 0, 0, 16, 0, ['#ffffff', '#eef1f0', '#c8d0cc']);
        c.fill(); c.strokeStyle = '#8f9c95'; c.lineWidth = 1.4; c.stroke();
        c.restore();
    }
    for (const y of [106, 128]) {
        rrect(c, 156, y, 990, 7, 2);
        fs(c, lin(c, 0, y, 0, y + 7, ['#ffffff', '#cfd6d2']), '#8f9c95', 1.2);
    }

    // 人行道 & 马路
    c.fillStyle = lin(c, 1140, 0, 1190, 0, ['#d6d1c4', '#c4beb0']);
    c.fillRect(1140, G.y - 8, 50, H);
    c.strokeStyle = 'rgba(90,80,60,.35)'; c.lineWidth = 1.5;
    for (let y = G.y; y < H; y += 57) { c.beginPath(); c.moveTo(1140, y); c.lineTo(1190, y); c.stroke(); }
    c.fillStyle = '#9b9588'; c.fillRect(1188, G.y - 8, 6, H);
    c.fillStyle = '#55565c'; c.fillRect(1194, G.y - 8, 90, H);
    for (let i = 0; i < 900; i++) { c.fillStyle = rgba(R() > 0.5 ? '#7a7b82' : '#3e3f44', 0.6); c.fillRect(rr(1194, W), rr(G.y - 8, H), 1.5, 1.5); }
    c.fillStyle = '#f4d35e';
    for (let y = G.y; y < H; y += 60) { rrect(c, 1250, y, 6, 32, 2); c.fill(); }
    // 人行道边草
    c.fillStyle = 'rgba(40,90,20,.35)'; c.fillRect(1136, G.y - 8, 5, H);

    // 房子
    drawHouse(c, rr);

    // 底部泥土边
    c.fillStyle = lin(c, 0, H - 10, 0, H, ['#6b4a2b', '#4a3019']);
    c.fillRect(150, H - 9, 990, 9);

    // 暗角
    const v = c.createRadialGradient(W / 2, H / 2 + 40, H * 0.45, W / 2, H / 2, H * 1.05);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,20,0,.32)');
    c.fillStyle = v; c.fillRect(0, 0, W, H);
    return cv;
}

function drawHouse(c, rr) {
    // 墙面
    c.fillStyle = lin(c, 0, 0, 150, 0, ['#d9c49a', '#efdfbb', '#e2cfa5']);
    c.fillRect(0, 0, 150, H);
    c.strokeStyle = 'rgba(120,90,50,.28)'; c.lineWidth = 1.5;
    for (let y = 8; y < H; y += 16) { c.beginPath(); c.moveTo(0, y); c.lineTo(150, y); c.stroke(); }
    // 屋檐
    c.beginPath(); c.moveTo(0, 0); c.lineTo(178, 0); c.lineTo(178, 34); c.lineTo(0, 62); c.closePath();
    fs(c, lin(c, 0, 0, 0, 60, ['#8d3b2a', '#6a2a1d']), '#3f1810', 2);
    for (let i = 0; i < 9; i++) {
        c.strokeStyle = 'rgba(0,0,0,.18)';
        c.beginPath(); c.moveTo(i * 20, 0); c.lineTo(i * 20, 60 - i * 2.8); c.stroke();
    }
    // 窗户
    const win = (x, y, w, h) => {
        rrect(c, x - 6, y - 6, w + 12, h + 12, 4); fs(c, '#f8f3e6', '#8a7350', 2);
        rrect(c, x, y, w, h, 2); fs(c, lin(c, x, y, x + w, y + h, ['#a8dcf5', '#5aa7d6', '#2f6f9f']), '#4a3a22', 1.5);
        c.fillStyle = 'rgba(255,255,255,.35)';
        c.beginPath(); c.moveTo(x + 6, y + h - 8); c.lineTo(x + w * 0.55, y + 6); c.lineTo(x + w * 0.75, y + 6); c.lineTo(x + 16, y + h - 8); c.fill();
        c.strokeStyle = '#f8f3e6'; c.lineWidth = 4;
        c.beginPath(); c.moveTo(x + w / 2, y); c.lineTo(x + w / 2, y + h); c.moveTo(x, y + h / 2); c.lineTo(x + w, y + h / 2); c.stroke();
        rrect(c, x - 10, y + h + 4, w + 20, 8, 3); fs(c, '#efe6d0', '#8a7350', 1.5);
    };
    win(34, 120, 74, 88);
    win(34, 560, 74, 70);
    // 门
    rrect(c, 52, 300, 84, 200, 6); fs(c, '#f2ead6', '#8a7350', 2);
    rrect(c, 62, 312, 66, 182, 4); fs(c, lin(c, 62, 0, 128, 0, ['#9c5a2a', '#7a421b', '#5c2f12']), '#3a1d08', 2);
    for (const [x, y, w, h] of [[70, 322, 50, 60], [70, 394, 50, 90]]) { rrect(c, x, y, w, h, 3); fs(c, 'rgba(255,255,255,.06)', 'rgba(0,0,0,.35)', 1.5); }
    circ(c, 76, 410, 5); fs(c, rad(c, 76, 410, 5, ['#fff6b0', '#d4a017', '#7a5a00']), '#5a4000', 1);
    // 台阶
    for (let i = 0; i < 3; i++) {
        rrect(c, 136 + i * 0, 470 + i * 14, 34 - i * 4 + 10, 14, 2);
        fs(c, lin(c, 0, 470 + i * 14, 0, 484 + i * 14, ['#cfc8bb', '#9a9387']), '#6e675c', 1.2);
    }
    // 墙脚砖
    for (let y = 60; y < H; y += 20) {
        for (let k = 0; k < 2; k++) {
            rrect(c, 144 + (Math.floor(y / 20) % 2) * 3, y + k * 10, 10, 9, 1.5);
            fs(c, '#b35a3a', '#6e3020', 1);
        }
    }
    // 灌木
    for (const [x, y] of [[150, 255], [150, 650], [158, 545]]) {
        for (let k = 0; k < 6; k++) {
            circ(c, x + rr(-16, 16), y + rr(-14, 10), rr(12, 18));
            fs(c, k % 2 ? '#3f8f2c' : '#56a83a', '#2a5f1c', 1.4);
        }
        for (let k = 0; k < 4; k++) { circ(c, x + rr(-14, 14), y + rr(-14, 6), 2.6); fs(c, '#ff6f91'); }
    }
}

// ======================================================================
// 植物绘制（原点 = 地面中心，朝右）
// ======================================================================
function drawSunflower(c, p) {
    const t = p.t, sw = Math.sin(t * 2.1 + p.seed) * 3;
    leaf(c, -2, -6, -34, -20, 9, '#4cae36', '#246b18');
    leaf(c, 2, -8, 32, -26, 9, '#4cae36', '#246b18');
    stem(c, [0, 0, sw * 0.4, -28, sw, -50], '#47a632', '#1f5e14', 9);
    c.save();
    c.translate(sw, -62);
    c.rotate(sw * 0.025);
    const glow = p.glow || 0;
    if (glow > 0) {
        c.fillStyle = rad(c, 0, 0, 60, [`rgba(255,240,120,${0.75 * glow})`, 'rgba(255,220,80,0)'], 0, 0);
        circ(c, 0, 0, 60); c.fill();
    }
    for (let layer = 0; layer < 2; layer++) {
        const n = 14, off = layer ? Math.PI / n : 0, len = layer ? 13 : 15, r0 = layer ? 23 : 25;
        for (let i = 0; i < n; i++) {
            c.save();
            c.rotate(i / n * TAU + off + Math.sin(t * 1.5 + i) * 0.02);
            ell(c, 0, -r0, layer ? 7.5 : 8.5, len);
            fs(c, layer ? lin(c, 0, -r0 - len, 0, -r0 + len, ['#fff176', '#ffd21f', '#f5b400']) : '#f3a200', layer ? '#d18a00' : '#b86f00', 1.4);
            c.restore();
        }
    }
    circ(c, 0, 0, 19);
    fs(c, rad(c, 0, 0, 19, ['#b47a35', '#8a561f', '#5e3710']), '#4a2a08', 2);
    c.fillStyle = 'rgba(60,30,5,.35)';
    for (let i = 0; i < 18; i++) {
        const a = i * 2.4, rr2 = 4 + (i % 4) * 3.4;
        circ(c, Math.cos(a) * rr2, Math.sin(a) * rr2 + 2, 1.3); c.fill();
    }
    const bl = blinkAmt(t, p.seed);
    eye(c, -6.5, -3, 3.4, 4.8, -6, -2.6, 2.2, bl, '#1a0e04', '#1a0e04');
    eye(c, 6.5, -3, 3.4, 4.8, 7, -2.6, 2.2, bl, '#1a0e04', '#1a0e04');
    c.beginPath(); c.arc(0, 4, 7.5, 0.18 * Math.PI, 0.82 * Math.PI);
    c.lineWidth = 2.2; c.strokeStyle = '#2a1404'; c.lineCap = 'round'; c.stroke();
    c.fillStyle = 'rgba(255,120,120,.45)';
    circ(c, -11, 5, 3.2); c.fill(); circ(c, 11, 5, 3.2); c.fill();
    c.restore();
}

function blinkAmt(t, seed) {
    const k = (t + seed * 7) % 4.2;
    return k < 0.14 ? Math.sin(k / 0.14 * Math.PI) : 0;
}

const SHOOTER = {
    pea: { hi: '#c4f58a', base: '#62c43a', dark: '#2c741a', stem: '#47a632', stemD: '#1f5e14', hole: '#163d0a' },
    snow: { hi: '#f2fdff', base: '#86d0f2', dark: '#2d6f9c', stem: '#5aa8cf', stemD: '#24607f', hole: '#10314a' },
    rep: { hi: '#a6e46c', base: '#43a02a', dark: '#1d5a10', stem: '#3d9228', stemD: '#174a0c', hole: '#0c2a06' },
};

function drawShooter(c, p, v) {
    const C = SHOOTER[v];
    const t = p.t, sw = Math.sin(t * 2.4 + p.seed) * 2.4;
    const rec = p.recoil || 0;
    leaf(c, 0, -2, -30, -4, 7, C.stem, C.stemD);
    leaf(c, 0, -2, 30, -6, 7, C.stem, C.stemD);
    leaf(c, 0, -3, -12, -20, 6, C.stem, C.stemD);
    stem(c, [0, 0, -7, -24, sw, -44], C.stem, C.stemD, 9);
    c.save();
    c.translate(sw - rec * 5, -58 + Math.sin(t * 2.4 + p.seed + 1) * 1.2);
    // 头冠
    if (v === 'pea') leaf(c, -15, -10, -38, -26, 6, C.stem, C.stemD);
    if (v === 'rep') { leaf(c, -15, -12, -40, -30, 7, C.stem, C.stemD); leaf(c, -18, -2, -42, -8, 6, C.stem, C.stemD); }
    if (v === 'snow') {
        for (const [a, L] of [[-2.6, 24], [-2.2, 30], [-1.8, 22], [-3.0, 18]]) {
            c.save(); c.rotate(a);
            c.beginPath(); c.moveTo(14, -5); c.lineTo(14 + L, 0); c.lineTo(14, 5); c.closePath();
            fs(c, lin(c, 14, 0, 14 + L, 0, ['#ffffff', '#bfe9ff', '#7cc6ee']), C.dark, 1.4);
            c.restore();
        }
    }
    // 头
    circ(c, 0, 0, 22);
    fs(c, rad(c, 0, 0, 22, [C.hi, C.base, C.dark]), darken(C.dark, 0.25), 2.2);
    // 嘴管
    const bulge = rec * 3;
    c.beginPath();
    c.moveTo(10, -6 - bulge * 0.5);
    c.lineTo(34, -8 - bulge);
    c.lineTo(34, 16 + bulge);
    c.lineTo(10, 14 + bulge * 0.5);
    c.closePath();
    fs(c, lin(c, 0, -8, 0, 16, [C.hi, C.base, C.dark]), darken(C.dark, 0.25), 2);
    ell(c, 35, 4, 6.5, 12.5 + bulge);
    fs(c, lin(c, 30, -8, 40, 16, [C.hi, C.base]), darken(C.dark, 0.25), 2);
    ell(c, 36.5, 4, 3.6, 8 + bulge * 0.8); fs(c, C.hole);
    // 眼睛
    eye(c, 5, -9, 6, 7.5, 8, -8.5, 3.2, blinkAmt(t, p.seed), '#ffffff', darken(C.dark, 0.3));
    if (v === 'rep') {
        c.beginPath(); c.moveTo(-1, -19); c.lineTo(13, -14);
        c.lineWidth = 3.2; c.strokeStyle = '#173f08'; c.lineCap = 'round'; c.stroke();
    }
    if (v === 'snow') {
        c.fillStyle = 'rgba(255,255,255,.7)';
        circ(c, -8, -10, 3); c.fill(); circ(c, -12, 2, 2); c.fill();
    }
    c.restore();
}

function drawWallnut(c, p) {
    const f = p.hp / p.maxHp, t = p.t;
    const sq = Math.sin(t * 1.7 + p.seed) * 0.018;
    c.save();
    c.scale(1 + sq, 1 - sq);
    ell(c, 0, -40, 31, 39);
    fs(c, rad(c, 0, -40, 40, ['#f4cf8e', '#d39a54', '#8a5626']), '#5a3412', 2.4);
    c.strokeStyle = 'rgba(110,60,20,.45)'; c.lineWidth = 1.6;
    for (const [x, y, r, a0, a1] of [[-14, -62, 9, 3.4, 5.4], [-18, -30, 10, 2.2, 4.0], [14, -18, 8, 0.2, 1.8], [20, -66, 7, 4.8, 6.4]]) {
        c.beginPath(); c.arc(x, y, r, a0, a1); c.stroke();
    }
    // 裂纹
    c.strokeStyle = '#4a2a0c'; c.lineWidth = 2; c.lineJoin = 'round';
    if (f < 0.67) {
        c.beginPath(); c.moveTo(-6, -79); c.lineTo(-2, -68); c.lineTo(-9, -60); c.lineTo(-4, -52); c.stroke();
        c.beginPath(); c.moveTo(29, -40); c.lineTo(20, -36); c.lineTo(22, -28); c.stroke();
    }
    if (f < 0.34) {
        c.beginPath(); c.moveTo(-30, -36); c.lineTo(-20, -30); c.lineTo(-24, -20); c.lineTo(-14, -14); c.stroke();
        c.beginPath(); c.moveTo(10, -77); c.lineTo(8, -66); c.lineTo(16, -60); c.stroke();
        ell(c, 22, -70, 7, 5, 0.6); fs(c, '#7a4a1e');
    }
    const bl = blinkAmt(t, p.seed);
    const look = Math.sin(t * 0.7 + p.seed) * 1.5;
    eye(c, 1, -50, 7, 9, 4 + look, -49, 3.6, bl, '#ffffff', '#3a1d06');
    eye(c, 18, -49, 6, 8, 21 + look, -48, 3.2, bl, '#ffffff', '#3a1d06');
    c.lineWidth = 2.2; c.strokeStyle = '#3a1d06'; c.lineCap = 'round';
    if (f < 0.34) {
        c.beginPath(); c.moveTo(-6, -64); c.lineTo(6, -61); c.moveTo(24, -61); c.lineTo(14, -60); c.stroke();
        c.beginPath(); c.arc(11, -24, 5, 1.15 * Math.PI, 1.85 * Math.PI); c.stroke();
    } else {
        c.beginPath(); c.moveTo(6, -26); c.quadraticCurveTo(11, -24, 16, -27); c.stroke();
    }
    c.restore();
}

function drawPotato(c, p) {
    const t = p.t;
    // 土堆
    ell(c, 0, -3, 32, 10); fs(c, lin(c, 0, -13, 0, 7, ['#9a6a3e', '#6e4622']), '#4a2c12', 1.6);
    if (!p.armed) {
        ell(c, 0, -9, 15, 9); fs(c, rad(c, 0, -9, 15, ['#e2c58b', '#b98d4f']), '#6e4a20', 1.6);
        c.beginPath(); c.moveTo(1, -17); c.lineTo(2, -24); c.lineWidth = 2; c.strokeStyle = '#555'; c.stroke();
        circ(c, 2, -25, 2.6); fs(c, '#7a2a2a');
    } else {
        const k = easeOutBack(clamp(p.armK, 0, 1));
        c.save();
        c.translate(0, (1 - k) * 18);
        ell(c, 0, -20, 25, 19);
        fs(c, rad(c, 0, -20, 26, ['#f0d69c', '#c9a063', '#8a6430']), '#5e3e16', 2);
        c.fillStyle = 'rgba(120,80,30,.4)';
        for (const [x, y] of [[-14, -24], [12, -10], [-6, -8], [16, -28]]) { ell(c, x, y, 2.4, 1.6); c.fill(); }
        c.beginPath(); c.moveTo(2, -38); c.quadraticCurveTo(-2, -46, 3, -52);
        c.lineWidth = 2.6; c.strokeStyle = '#4b4b4b'; c.stroke();
        const on = Math.sin(t * 6) > 0;
        if (on) { c.fillStyle = rad(c, 3, -55, 16, ['rgba(255,80,60,.7)', 'rgba(255,60,40,0)'], 0, 0); circ(c, 3, -55, 16); c.fill(); }
        circ(c, 3, -55, 5.2); fs(c, rad(c, 3, -55, 5.2, on ? ['#fff0e0', '#ff4a3a', '#a01010'] : ['#e09090', '#902020', '#501010']), '#3a0808', 1.4);
        eye(c, -6, -24, 4.2, 5.2, -4, -23.5, 2.2, blinkAmt(t, p.seed), '#fff', '#3a2408');
        eye(c, 8, -24, 4.2, 5.2, 10, -23.5, 2.2, blinkAmt(t, p.seed), '#fff', '#3a2408');
        c.beginPath(); c.arc(2, -15, 4.5, 0.15 * Math.PI, 0.85 * Math.PI); c.lineWidth = 2; c.strokeStyle = '#3a2408'; c.stroke();
        c.restore();
    }
    // 前方土粒
    c.fillStyle = '#7a5230';
    for (const [x, y, r] of [[-24, -2, 4], [-12, 2, 3.5], [10, 2, 4], [24, -1, 3.4], [0, 4, 3]]) { circ(c, x, y, r); c.fill(); }
}

function drawCherry(c, p) {
    const f = p.fuse || 0;
    const s = 1 + f * 0.38 + Math.sin(f * 50) * 0.03 * f;
    c.save();
    c.translate(0, -32);
    c.scale(s, s);
    stem(c, [-14, -10, -12, -34, 2, -48], '#4cae36', '#1f5e14', 5.5);
    stem(c, [14, -2, 14, -30, 2, -48], '#4cae36', '#1f5e14', 5.5);
    leaf(c, 2, -48, 22, -56, 6, '#4cae36', '#1f5e14');
    const ball = (x, y, r, flip) => {
        circ(c, x, y, r);
        const hot = f > 0.5 ? (f - 0.5) * 2 : 0;
        fs(c, rad(c, x, y, r, [mix('#ff8a80', '#ffffff', hot * 0.5), mix('#e8202a', '#ff6040', hot), mix('#8a0010', '#c02000', hot)]), '#4a0008', 2.2);
        ell(c, x - r * 0.4, y - r * 0.5, r * 0.25, r * 0.15, -0.6); fs(c, 'rgba(255,255,255,.7)');
        // 怒眼
        eye(c, x - 6, y - 2, 4.4, 4.8, x - 5 + flip, y - 1, 2.2, 0, '#fff', '#3a0008');
        eye(c, x + 6, y - 2, 4.4, 4.8, x + 7 + flip, y - 1, 2.2, 0, '#fff', '#3a0008');
        c.lineWidth = 2.4; c.strokeStyle = '#3a0008'; c.lineCap = 'round';
        c.beginPath(); c.moveTo(x - 11, y - 10); c.lineTo(x - 2, y - 6); c.moveTo(x + 11, y - 10); c.lineTo(x + 2, y - 6); c.stroke();
        ell(c, x, y + 8, 5, 2.4 + f * 3); fs(c, '#3a0008');
    };
    ball(-15, -2, 18, -1);
    ball(14, 6, 18, 1);
    c.restore();
}

function drawChomper(c, p) {
    const t = p.t;
    const st = p.cState || 'idle';
    leaf(c, 0, -2, -34, -8, 8, '#4cae36', '#1f5e14');
    leaf(c, 0, -2, 32, -14, 8, '#4cae36', '#1f5e14');
    leaf(c, 0, -4, -18, -26, 6, '#4cae36', '#1f5e14');
    let open, lunge = 0, chew = st === 'chew';
    if (st === 'bite') {
        const k = clamp(p.bt / 0.45, 0, 1);
        open = k < 0.6 ? 0.25 + k / 0.6 * 0.6 : 0.85 * (1 - (k - 0.6) / 0.4);
        lunge = Math.sin(k * Math.PI) * 26;
    } else if (chew) open = 0.04 + Math.abs(Math.sin(t * 5)) * 0.08;
    else open = 0.3 + Math.sin(t * 2.2 + p.seed) * 0.1;
    const sw = Math.sin(t * 1.8 + p.seed) * 2;
    stem(c, [0, 0, -14, -20, -10, -42, -4 + lunge * 0.5 + sw, -58], '#47a632', '#1f5e14', 9);
    c.save();
    c.translate(-6 + lunge + sw, -64 + (chew ? Math.sin(t * 5) * 2 : 0));
    const purple = ['#e09af5', '#b04fd8', '#5e1880'];
    // 口腔
    ell(c, 26, 2, 28, 22 * open + 3); fs(c, '#5a0a24');
    ell(c, 26, 6 + 10 * open, 16, 5 * open + 1); fs(c, '#ff6f91');
    // 下颚
    c.save(); c.rotate(open * 0.5);
    c.beginPath(); c.ellipse(26, 0, 30, chew ? 20 : 16, 0, 0, Math.PI); c.closePath();
    fs(c, lin(c, 0, 0, 0, 18, purple), '#3a0a52', 2);
    c.fillStyle = '#ffffff';
    for (let i = 0; i < 5; i++) { const x = 6 + i * 9; c.beginPath(); c.moveTo(x, 0); c.lineTo(x + 3.5, -7); c.lineTo(x + 7, 0); c.fill(); }
    c.restore();
    // 上颚
    c.save(); c.rotate(-open);
    c.beginPath(); c.ellipse(24, 0, 35, chew ? 34 : 30, 0, Math.PI, TAU); c.closePath();
    fs(c, rad(c, 24, -12, 36, purple), '#3a0a52', 2.2);
    c.fillStyle = 'rgba(255,230,255,.55)';
    for (const [x, y, r] of [[8, -18, 4], [26, -24, 3], [40, -14, 3.6], [18, -8, 2.4]]) { circ(c, x, y, r); c.fill(); }
    c.fillStyle = '#ffffff';
    for (let i = 0; i < 6; i++) { const x = -4 + i * 9.5; c.beginPath(); c.moveTo(x, 0); c.lineTo(x + 3.8, 8); c.lineTo(x + 7.5, 0); c.fill(); }
    c.restore();
    c.restore();
}

const DRAW_PLANT = {
    sunflower: drawSunflower,
    peashooter: (c, p) => drawShooter(c, p, 'pea'),
    snowpea: (c, p) => drawShooter(c, p, 'snow'),
    repeater: (c, p) => drawShooter(c, p, 'rep'),
    wallnut: drawWallnut,
    potatomine: drawPotato,
    cherrybomb: drawCherry,
    chomper: drawChomper,
};

function portraitOf(type) {
    return { type, t: 0.3, seed: 0, hp: PT[type].hp, maxHp: PT[type].hp, armed: true, armK: 1, fuse: 0, cState: 'idle', recoil: 0 };
}

// ======================================================================
// 僵尸绘制（原点 = 脚底中心，朝左）
// ======================================================================
const ZBASE = {
    skin: '#97a183', skinHi: '#c8ccb0', skinD: '#59644a', bruise: '#6d5868', vein: '#4f4660',
    blood: '#5e1a14', socket: '#24231b',
    coat: '#5b4b3b', coatHi: '#7b6852', coatD: '#30271e',
    pants: '#41475c', pantsD: '#2a2e3d', shirt: '#cbc2a2', shirtD: '#8f8566', tie: '#7c2026',
    shoe: '#221b16', eyeW: '#ddd6a8', iris: '#8f927a', line: '#1b1a14', mouth: '#250c0a',
    gum: '#6b2b2b', tooth: '#d3c793', bone: '#e2d7b8', dirt: '#3d3222',
};
const FBASE = Object.assign({}, ZBASE, { coat: '#ad2f2b', coatHi: '#cc4a42', coatD: '#651513', pants: '#d6d3c8', pantsD: '#96928a', shirt: '#ad2f2b', shirtD: '#651513', tie: '#ad2f2b' });
const ASH = {};
for (const k in ZBASE) ASH[k] = k === 'eyeW' ? '#ffb347' : (k === 'skinHi' || k === 'coatHi' ? '#4a403a' : '#211b18');
function tintPal(P, col, t) { const o = {}; for (const k in P) o[k] = mix(P[k], col, t); return o; }
const PALS = {
    normal: { n: ZBASE, s: tintPal(ZBASE, '#6fb3ff', 0.42) },
    football: { n: FBASE, s: tintPal(FBASE, '#6fb3ff', 0.42) },
};
// 每只僵尸固定的随机外观特征
const zv = (z, i) => (z && z.v ? z.v[i % z.v.length] : 0.5);

function drawZombie(c, z) {
    const P = z.burnt ? ASH : (z.slow > 0 ? PALS[z.palKey].s : PALS[z.palKey].n);
    const fb = z.type === 'football';
    const eat = z.eating && !z.dying;
    const still = eat || z.burnt;
    const ph = z.ph;
    // 拖着一条腿走：前腿摆幅大，后腿拖地
    const swF = still ? 0 : Math.sin(ph) * (fb ? 0.62 : 0.46);
    const swB = still ? 0 : -Math.sin(ph) * (fb ? 0.62 : 0.28);
    const bob = eat ? Math.sin(z.t * 9) * 1.2 : -Math.abs(Math.sin(ph)) * 3.2;
    const lurch = still ? 0 : Math.sin(ph) * 0.05;
    const et = z.t * (z.slow > 0 ? 4.5 : 9);
    const armF = eat ? 0.38 + Math.sin(et) * 0.32 : 0.02 + Math.sin(ph + 1) * 0.09;
    const armB = eat ? 0.32 + Math.sin(et + 1.6) * 0.32 : -0.14 + Math.sin(ph) * 0.07;
    c.save();
    c.translate(0, bob);
    drawZLeg(c, P, z, 9, -50, swB, fb, false);
    drawZLeg(c, P, z, -5, -50, swF, fb, true);
    // 上身前倾驼背（以髋部为轴）
    c.translate(2, -50);
    c.rotate((fb ? -0.2 : -0.11) + lurch);
    c.translate(-2, 50);
    drawZArm(c, P, 8, -94, armB, false, fb, z);
    drawZTorso(c, P, z, fb);
    if (!z.headless) {
        const hb = eat ? Math.sin(et) * 2 : Math.sin(ph * 2) * 1;
        c.save();
        c.translate(-5, -115 + hb);
        c.rotate(eat ? -0.05 + Math.sin(et) * 0.07 : 0.07 + Math.sin(ph) * 0.05);
        drawZHead(c, P, z, eat ? (Math.sin(et) > 0 ? 1 : 0.25) : 0.35);
        c.restore();
    } else {
        rrect(c, -5, -112, 5, 9, 2); fs(c, P.bone, P.line, 1.2);
        ell(c, -3, -104, 8, 4); fs(c, '#5a1410', P.line, 1.4);
        ell(c, -3, -105, 4, 1.8); fs(c, '#8a2a20');
    }
    if (z.type === 'flag' && !z.burnt) drawFlag(c, z);
    if (!z.armLost) drawZArm(c, P, -6, -92, armF, true, fb, z);
    else {
        c.save(); c.translate(-6, -92); c.rotate(armF);
        c.beginPath(); c.moveTo(6, -7.5); c.lineTo(-12, -6); c.lineTo(-15, -2); c.lineTo(-11, 1); c.lineTo(-15, 5); c.lineTo(6, 7.5); c.closePath();
        fs(c, P.coat, P.line, 1.6);
        rrect(c, -20, -2, 8, 4, 1.5); fs(c, P.bone, P.line, 1);
        circ(c, -20, 0, 2.6); fs(c, P.bone, P.line, 1);
        ell(c, -13, 0, 2.5, 5); fs(c, '#5a1410');
        c.restore();
    }
    c.restore();
    if (!z.dying && zv(z, 7) > 0.45) drawFlies(c, z);
}

function drawFlies(c, z) {
    const n = zv(z, 8) > 0.7 ? 3 : 2;
    for (let i = 0; i < n; i++) {
        const a = z.t * (4.6 + i * 1.3) + i * 2.1;
        const x = -12 + Math.cos(a) * (16 + i * 6) + Math.sin(a * 2.3) * 4;
        const y = -130 + Math.sin(a * 1.4) * (10 + i * 3);
        const wf = 1 + Math.abs(Math.sin(z.t * 70 + i)) * 0.8;
        c.fillStyle = 'rgba(225,235,245,.55)';
        ell(c, x - 1.6, y - 2.4, 2.3, wf, -0.5); c.fill();
        ell(c, x + 1.6, y - 2.4, 2.3, wf, 0.5); c.fill();
        circ(c, x, y, 1.6); c.fillStyle = '#121010'; c.fill();
    }
}

function drawZArm(c, P, x, y, a, front, fb, z) {
    c.save(); c.translate(x, y); c.rotate(a);
    const skin = front ? P.skin : P.skinD;
    const sleeve = front ? P.coat : P.coatD;
    const s0 = fb ? -14 : -26;
    if (fb) {
        rrect(c, -16, -7.5, 22, 15, 6);
        fs(c, lin(c, 0, -7, 0, 7, [lighten(sleeve, 0.12), sleeve, darken(sleeve, 0.25)]), P.line, 1.6);
    } else {
        c.beginPath();
        c.moveTo(6, -7.5); c.lineTo(-25, -6.2); c.lineTo(-28, -3); c.lineTo(-25, -1); c.lineTo(-31, 2.2); c.lineTo(-26.5, 4.6); c.lineTo(-29, 7); c.lineTo(6, 7.5);
        c.closePath();
        fs(c, lin(c, 0, -7, 0, 7, [lighten(sleeve, 0.12), sleeve, darken(sleeve, 0.28)]), P.line, 1.5);
        c.strokeStyle = rgba(P.line, 0.35); c.lineWidth = 1.1;
        c.beginPath(); c.moveTo(-6, -6.5); c.quadraticCurveTo(-10, 0, -7, 6.5); c.moveTo(-16, -6); c.quadraticCurveTo(-19, 0, -17, 6); c.stroke();
        if (z && zv(z, 11) > 0.5) { ell(c, -10, 2, 3.5, 2.2); fs(c, rgba(P.dirt, 0.55)); }
    }
    // 消瘦的小臂
    c.beginPath();
    c.moveTo(s0, -4.4); c.quadraticCurveTo(s0 - 9, -2.6, -44, -3.2);
    c.lineTo(-44, 3.4); c.quadraticCurveTo(s0 - 9, 3.6, s0, 4.6);
    c.closePath();
    fs(c, lin(c, 0, -4, 0, 4, [lighten(skin, 0.15), skin, darken(skin, 0.22)]), P.line, 1.4);
    c.strokeStyle = rgba(P.vein, 0.45); c.lineWidth = 0.8;
    c.beginPath(); c.moveTo(s0 - 2, 0.5); c.quadraticCurveTo(-36, -1.5, -42, 1); c.stroke();
    circ(c, -42.5, -2.6, 1.8); fs(c, rgba(P.skinHi, 0.55));
    // 手掌与细长手指
    ell(c, -48, 0.5, 6.4, 5.2, -0.15);
    fs(c, rad(c, -48, 0.5, 7, [lighten(skin, 0.1), skin, darken(skin, 0.2)]), P.line, 1.4);
    const curl = front ? 0.5 : 0.9;
    const tips = [];
    c.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
        c.beginPath();
        for (let i = 0; i < 4; i++) {
            const fy = -3.6 + i * 2.5, L = 10 - Math.abs(i - 1.2) * 1.5;
            const tx = -53 - L - 1.5, ty = fy + curl * 3.2;
            c.moveTo(-52, fy);
            c.quadraticCurveTo(-52 - L, fy - 0.6 + i * 0.3, tx, ty);
            if (!pass) tips.push([tx, ty]);
        }
        c.moveTo(-46, -4.5); c.quadraticCurveTo(-51, -8.5, -55, -7.5);
        c.lineWidth = pass ? 1.7 : 3.3; c.strokeStyle = pass ? skin : P.line; c.stroke();
    }
    for (const [tx, ty] of tips) { circ(c, tx, ty, 0.95); fs(c, P.dirt); }
    c.restore();
}

function drawZLeg(c, P, z, x, y, a, fb, front) {
    c.save(); c.translate(x, y); c.rotate(a);
    const pants = front ? P.pants : darken(P.pants, 0.15);
    c.beginPath(); c.moveTo(-8, -4); c.lineTo(8, -4); c.lineTo(7, 28); c.lineTo(-7, 28); c.closePath();
    fs(c, lin(c, -8, 0, 8, 0, [lighten(pants, 0.1), pants, darken(pants, 0.28)]), P.line, 1.5);
    c.strokeStyle = rgba(P.line, 0.3); c.lineWidth = 1;
    c.beginPath(); c.moveTo(-6, 8); c.quadraticCurveTo(0, 11, 5, 7); c.moveTo(-5, 18); c.quadraticCurveTo(0, 21, 6, 17); c.stroke();
    // 膝盖弯曲
    c.save();
    c.translate(0, 26);
    c.rotate(-0.05 - Math.max(0, -a) * 0.7);
    const torn = !fb && zv(z, front ? 1 : 2) > 0.55;
    const pD = front ? P.pantsD : darken(P.pantsD, 0.15);
    if (torn) {
        c.beginPath(); c.moveTo(-7, -2); c.lineTo(7, -2); c.lineTo(6.5, 8); c.lineTo(3, 5); c.lineTo(0.5, 10); c.lineTo(-2.5, 6); c.lineTo(-6.5, 9.5); c.closePath();
        fs(c, pD, P.line, 1.4);
        rrect(c, -4, 6, 8, 15, 3);
        fs(c, lin(c, -4, 0, 4, 0, [P.skinHi, P.skin, P.skinD]), P.line, 1.3);
        c.beginPath(); c.moveTo(-1.5, 8); c.lineTo(-1, 19); c.lineWidth = 1.2; c.strokeStyle = rgba(P.bone, 0.6); c.stroke();
    } else {
        c.beginPath(); c.moveTo(-6.5, -2); c.lineTo(6.5, -2); c.lineTo(6, 18); c.lineTo(3, 20); c.lineTo(0, 17.5); c.lineTo(-3, 20); c.lineTo(-6, 18); c.closePath();
        fs(c, lin(c, -6, 0, 6, 0, [lighten(pD, 0.1), pD, darken(pD, 0.25)]), P.line, 1.4);
    }
    const bare = !fb && zv(z, front ? 3 : 4) > 0.78;
    if (bare) {
        c.beginPath(); c.moveTo(-4, 18); c.quadraticCurveTo(-15, 18.5, -17, 24.5); c.lineTo(5, 25.5); c.lineTo(5, 18); c.closePath();
        fs(c, lin(c, 0, 18, 0, 26, [P.skin, P.skinD]), P.line, 1.3);
        for (let i = 0; i < 4; i++) { circ(c, -16 + i * 2.6, 24.2, 1.5); fs(c, P.skinD, P.line, 0.8); }
    } else {
        c.beginPath(); c.moveTo(-5, 17); c.quadraticCurveTo(-20, 16, -20, 24); c.lineTo(7, 24); c.lineTo(7, 17); c.closePath();
        fs(c, lin(c, 0, 16, 0, 24, [lighten(P.shoe, 0.18), P.shoe]), '#0b0806', 1.4);
        const flap = !fb && front && zv(z, 5) > 0.5 ? Math.max(0, Math.sin(z.ph * 1)) * 3 : 0;
        c.beginPath(); c.moveTo(7, 24); c.lineTo(-6, 24); c.lineTo(-20, 24 + flap); c.lineTo(-19, 26 + flap); c.lineTo(7, 26.5); c.closePath();
        fs(c, darken(P.shoe, 0.35));
        c.strokeStyle = rgba(P.shoeHi || '#8a7a66', 0.5); c.lineWidth = 0.9;
        c.beginPath(); c.moveTo(-6, 18); c.lineTo(-3, 20.5); c.moveTo(-3, 17.5); c.lineTo(0, 20); c.stroke();
        if (fb) { c.fillStyle = '#ccc'; for (let i = 0; i < 3; i++) c.fillRect(-16 + i * 8, 26, 3, 3); }
    }
    c.restore();
    c.restore();
}

function drawZTorso(c, P, z, fb) {
    // 脖子（筋腱外露）
    c.beginPath(); c.moveTo(-9, -113); c.lineTo(-1, -114); c.lineTo(3, -98); c.lineTo(-8, -98); c.closePath();
    fs(c, lin(c, -9, 0, 3, 0, [P.skin, P.skinD]), P.line, 1.3);
    c.strokeStyle = rgba(P.line, 0.4); c.lineWidth = 1;
    c.beginPath(); c.moveTo(-6, -112); c.lineTo(-4, -100); c.stroke();
    // 外套（下摆破烂）
    const hem = [[15, -44], [10, -49], [4, -41], [-2, -48], [-7, -43], [-13, -47], [-17, -42]];
    const coatPath = () => {
        c.beginPath();
        c.moveTo(-17, -101);
        c.quadraticCurveTo(0, -109, 19, -100);
        c.lineTo(23, -50);
        for (const [hx, hy] of hem) c.lineTo(hx, hy + (zv(z, Math.abs(hx)) - 0.5) * 4);
        c.lineTo(-21, -46);
        c.closePath();
    };
    coatPath();
    fs(c, lin(c, -21, 0, 23, 0, [P.coatHi, P.coat, P.coatD]), P.line, 1.8);
    c.save();
    coatPath(); c.clip();
    c.fillStyle = lin(c, 0, -100, 0, -42, ['rgba(0,0,0,0)', 'rgba(0,0,0,.28)']);
    c.fillRect(-25, -110, 50, 70);
    // 污渍
    c.fillStyle = rgba(P.dirt, 0.45);
    ell(c, 12 + zv(z, 0) * 6, -60, 6, 4, 0.4); c.fill();
    ell(c, -14, -56 - zv(z, 1) * 8, 4, 6); c.fill();
    c.fillStyle = rgba(P.blood, 0.4);
    ell(c, -8 + zv(z, 2) * 8, -88, 3.5, 5); c.fill();
    // 破洞露出肋骨
    if (!fb && zv(z, 6) > 0.35) {
        const hx = 13, hy = -74;
        c.beginPath();
        c.moveTo(hx - 5, hy - 9); c.lineTo(hx + 1, hy - 11); c.lineTo(hx + 7, hy - 6); c.lineTo(hx + 6, hy + 3); c.lineTo(hx + 1, hy + 10); c.lineTo(hx - 5, hy + 6); c.lineTo(hx - 7, hy - 2);
        c.closePath();
        fs(c, '#1d1310', P.line, 1.2);
        c.strokeStyle = P.bone; c.lineWidth = 1.8; c.lineCap = 'round';
        c.beginPath();
        for (let i = 0; i < 3; i++) { const yy = hy - 5 + i * 5; c.moveTo(hx - 5, yy); c.quadraticCurveTo(hx, yy - 2.5, hx + 5, yy + 0.5); }
        c.stroke();
    } else if (!fb) {
        rrect(c, 9, -82, 10, 12, 1.5); fs(c, rgba(P.coatHi, 0.7), rgba(P.line, 0.5), 1);
        c.strokeStyle = rgba(P.shirt, 0.7); c.lineWidth = 0.8;
        c.beginPath(); for (let i = 0; i < 4; i++) { c.moveTo(9 + i * 3, -83.5); c.lineTo(10 + i * 3, -80.5); } c.stroke();
    }
    c.restore();
    if (!fb) {
        // 脏衬衫
        c.beginPath(); c.moveTo(-10, -104); c.lineTo(7, -104); c.lineTo(-2, -70); c.closePath();
        fs(c, lin(c, 0, -104, 0, -70, [P.shirt, P.shirtD]), P.line, 1.2);
        c.fillStyle = rgba(P.blood, 0.5);
        ell(c, -3, -84, 2.4, 4.5); c.fill();
        c.beginPath(); c.moveTo(-10, -104); c.lineTo(-6, -98); c.lineTo(-3, -104); c.moveTo(7, -104); c.lineTo(2, -98); c.lineTo(-1, -104);
        c.lineWidth = 1.1; c.strokeStyle = rgba(P.line, 0.6); c.stroke();
        // 松垮歪斜的领带
        c.save(); c.translate(-3, -99); c.rotate(0.22);
        c.beginPath(); c.moveTo(-2.5, 0); c.lineTo(2.5, 0); c.lineTo(1.6, 4); c.lineTo(-1.6, 4); c.closePath();
        fs(c, darken(P.tie, 0.15), P.line, 1);
        c.beginPath(); c.moveTo(-1.6, 4); c.lineTo(1.6, 4); c.lineTo(3.2, 18); c.lineTo(1, 22); c.lineTo(-0.5, 19); c.lineTo(-2.5, 23); c.lineTo(-3, 17); c.closePath();
        fs(c, lin(c, -3, 0, 3, 0, [lighten(P.tie, 0.15), P.tie, darken(P.tie, 0.3)]), P.line, 1.1);
        c.restore();
        c.strokeStyle = rgba(P.line, 0.65); c.lineWidth = 1.4;
        c.beginPath(); c.moveTo(-10, -104); c.lineTo(-15, -81); c.lineTo(-3, -69); c.moveTo(7, -104); c.lineTo(13, -83); c.lineTo(0, -69); c.stroke();
        circ(c, 5, -61, 1.9); fs(c, darken(P.coatD, 0.2));
        c.beginPath(); c.moveTo(4, -54); c.quadraticCurveTo(3, -51, 4.5, -48.5); c.lineWidth = 0.7; c.strokeStyle = rgba(P.shirt, 0.8); c.stroke();
        circ(c, 4.5, -47.5, 1.9); fs(c, darken(P.coatD, 0.2));
    } else {
        c.font = `bold 15px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
        c.fillStyle = rgba(P.shirtD === ASH.shirtD ? '#222222' : '#f0ece0', 0.9);
        c.fillText('99', 2, -64);
        ell(c, 0, -100, 27, 12);
        fs(c, rad(c, 0, -100, 27, [P.coatHi, P.coat, P.coatD]), P.line, 2);
        c.strokeStyle = 'rgba(240,236,224,.7)'; c.lineWidth = 2.2;
        c.beginPath(); c.ellipse(0, -100, 20, 7, 0, Math.PI * 1.1, Math.PI * 1.9); c.stroke();
        c.fillStyle = rgba(P.dirt, 0.5);
        ell(c, -12, -102, 5, 3); c.fill(); ell(c, 14, -97, 4, 2.5); c.fill();
    }
}

function zHeadPath(c) {
    c.beginPath();
    c.moveTo(-15, 20);
    c.bezierCurveTo(-4, 25, 8, 20, 12, 12);
    c.bezierCurveTo(22, 6, 24, -14, 14, -24);
    c.bezierCurveTo(4, -32, -14, -30, -20, -19);
    c.bezierCurveTo(-24, -13, -23, -8, -22, -5);
    c.lineTo(-26.5, 4);
    c.lineTo(-22, 7);
    c.bezierCurveTo(-25, 11, -23, 17, -21, 18.5);
    c.bezierCurveTo(-19, 20.5, -17, 21, -15, 20);
    c.closePath();
}

function drawZEye(c, P, x, y, rx, ry, look) {
    ell(c, x, y, rx, ry);
    fs(c, rad(c, x, y, rx, [P.eyeW, mix(P.eyeW, '#c09070', 0.45)], 0, 0), P.line, 1);
    c.strokeStyle = 'rgba(170,50,40,.55)'; c.lineWidth = 0.6;
    c.beginPath();
    c.moveTo(x + rx, y); c.lineTo(x + rx * 0.4, y - 0.6);
    c.moveTo(x - rx, y + 0.5); c.lineTo(x - rx * 0.45, y + 1);
    c.moveTo(x + rx * 0.7, y + ry * 0.6); c.lineTo(x + rx * 0.2, y + ry * 0.2);
    c.stroke();
    circ(c, x + look, y + 0.6, rx * 0.44); fs(c, P.iris);
    circ(c, x + look, y + 0.6, rx * 0.17); fs(c, '#2a2a22');
    // 下垂的眼皮
    c.save();
    ell(c, x, y, rx, ry); c.clip();
    c.fillStyle = P.skinD; c.fillRect(x - rx - 1, y - ry - 1, rx * 2 + 2, ry * 0.6);
    c.restore();
    c.beginPath(); c.moveTo(x - rx, y - ry * 0.15); c.quadraticCurveTo(x, y - ry * 0.05, x + rx, y - ry * 0.35);
    c.lineWidth = 1.3; c.strokeStyle = P.line; c.stroke();
}

function drawZHead(c, P, z, mouthOpen) {
    const armorOn = z.armor > 0 && !z.burnt ? z.armorType : null;
    // 耳朵（破损）
    ell(c, 14, 0, 4.5, 7, 0.2);
    fs(c, lin(c, 10, 0, 18, 0, [P.skin, P.skinD]), P.line, 1.3);
    if (zv(z, 9) > 0.5) { c.beginPath(); c.moveTo(17.5, -6); c.lineTo(13.5, -3); c.lineTo(18.8, -1); c.closePath(); fs(c, P.socket); }
    zHeadPath(c);
    fs(c, rad(c, -4, -6, 30, [P.skinHi, P.skin, P.skinD], -0.45, -0.45), P.line, 1.6);
    c.save();
    zHeadPath(c); c.clip();
    // 斑驳的腐烂皮肤
    c.fillStyle = rgba(P.bruise, 0.32);
    ell(c, 6 + zv(z, 0) * 8, -12 + zv(z, 1) * 10, 6, 4, 0.5); c.fill();
    ell(c, -8 + zv(z, 2) * 6, 14, 4, 3); c.fill();
    c.fillStyle = rgba(P.skinD, 0.45);
    ell(c, 10, 6, 5, 3.5, -0.3); c.fill();
    ell(c, -2 + zv(z, 3) * 6, -22, 3.5, 2.5); c.fill();
    // 凹陷的脸颊
    c.fillStyle = rad(c, -6, 8, 11, [rgba(P.socket, 0.45), rgba(P.socket, 0)], 0, 0);
    circ(c, -6, 8, 11); c.fill();
    // 后脑阴影
    c.fillStyle = lin(c, 4, 0, 24, 0, ['rgba(0,0,0,0)', 'rgba(0,0,0,.3)']);
    c.fillRect(4, -32, 22, 60);
    // 太阳穴血管
    c.strokeStyle = rgba(P.vein, 0.5); c.lineWidth = 0.8;
    c.beginPath(); c.moveTo(6, -6); c.quadraticCurveTo(9, -12, 7, -17); c.moveTo(8, -11); c.lineTo(12, -13); c.stroke();
    // 深陷的眼窝
    c.fillStyle = rad(c, -14, -5, 9, [rgba(P.socket, 0.85), rgba(P.socket, 0)], 0, 0);
    circ(c, -14, -5, 9); c.fill();
    c.fillStyle = rad(c, -1, -6, 7.5, [rgba(P.socket, 0.8), rgba(P.socket, 0)], 0, 0);
    circ(c, -1, -6, 7.5); c.fill();
    c.restore();
    // 眉骨
    c.strokeStyle = rgba(P.line, 0.85); c.lineWidth = 2; c.lineCap = 'round';
    c.beginPath(); c.moveTo(-21, -11); c.quadraticCurveTo(-15, -14.5, -8, -11.5); c.moveTo(-5, -12); c.quadraticCurveTo(0, -14, 5, -11); c.stroke();
    // 眼睛
    const look = Math.sin(z.t * 0.8 + zv(z, 4) * 6) * 0.8 - 0.8;
    drawZEye(c, P, -14, -5, 5.8, 5.2, look);
    drawZEye(c, P, -1, -6, 4.8, 4.5, look);
    // 鼻子
    c.beginPath(); c.moveTo(-20, -3); c.quadraticCurveTo(-25, 1, -25, 4.5); c.lineTo(-21.5, 6);
    c.lineWidth = 1.2; c.strokeStyle = rgba(P.line, 0.8); c.stroke();
    ell(c, -23.2, 4.6, 1.6, 1); fs(c, P.socket);
    // 嘴：牙龈外露、牙齿残缺
    const m = 1.6 + mouthOpen * 6;
    const mouth = () => {
        c.beginPath();
        c.moveTo(-24, 11);
        c.quadraticCurveTo(-18, 9.4, -10.5, 12);
        c.quadraticCurveTo(-17, 12 + m * 1.2, -23, 11 + m);
        c.closePath();
    };
    mouth();
    fs(c, P.mouth, P.line, 1.2);
    c.save();
    mouth(); c.clip();
    c.fillStyle = P.gum; c.fillRect(-25, 8, 16, 3.4);
    for (let i = 0; i < 5; i++) {
        if (zv(z, 10 + i) < 0.22) continue;
        const tx = -23 + i * 2.7, th = 2.3 + ((i * 7) % 3) * 0.7;
        c.fillStyle = i % 2 ? P.tooth : darken(P.tooth, 0.12);
        rrect(c, tx, 10.4, 2.2, th, 0.6); c.fill();
    }
    for (let i = 0; i < 3; i++) {
        const tx = -21 + i * 3.4;
        c.fillStyle = darken(P.tooth, 0.2);
        rrect(c, tx, 10 + m - 2.4, 2.2, 3, 0.6); c.fill();
    }
    c.restore();
    c.strokeStyle = rgba(P.line, 0.5); c.lineWidth = 1;
    c.beginPath(); c.moveTo(-20, 17 + mouthOpen * 2); c.quadraticCurveTo(-14, 19 + mouthOpen * 2, -9, 16); c.stroke();
    // 缝合伤口
    if (!armorOn && zv(z, 10) > 0.4) {
        c.lineCap = 'round';
        c.beginPath(); c.moveTo(-6, -22); c.quadraticCurveTo(2, -20, 9, -13);
        c.lineWidth = 2; c.strokeStyle = rgba(P.blood, 0.85); c.stroke();
        c.lineWidth = 0.9; c.strokeStyle = '#141210';
        c.beginPath();
        for (let i = 0; i < 4; i++) { const sx = -4 + i * 3.6, sy = -21.5 + i * 2.2; c.moveTo(sx - 1.4, sy - 2.4); c.lineTo(sx + 1.4, sy + 2.4); }
        c.stroke();
    }
    // 稀疏的头发
    if (!armorOn) {
        c.strokeStyle = '#24201a'; c.lineWidth = 1.1; c.lineCap = 'round';
        c.beginPath();
        c.moveTo(2, -27); c.bezierCurveTo(6, -34, 12, -33, 14, -28);
        c.moveTo(8, -25); c.bezierCurveTo(16, -24, 21, -18, 21, -8);
        c.moveTo(-6, -27); c.quadraticCurveTo(-9, -34, -5, -36);
        c.moveTo(12, -22); c.bezierCurveTo(18, -18, 20, -10, 18, -2);
        c.stroke();
    }
    if (armorOn) {
        const f = z.armor / z.maxArmor;
        if (armorOn === 'cone') drawCone(c, f);
        else if (armorOn === 'bucket') drawBucket(c, f);
        else drawHelmet(c, f);
    }
}

function drawCone(c, f) {
    c.save(); c.translate(3, -16); c.rotate(0.12);
    const bent = f < 0.34;
    c.beginPath();
    c.moveTo(-22, 0);
    if (bent) { c.lineTo(-6, -36); c.quadraticCurveTo(4, -48, 18, -44); c.lineTo(8, -36); }
    else { c.lineTo(-3, -54); c.quadraticCurveTo(0, -58, 3, -54); }
    c.lineTo(22, 0);
    c.closePath();
    c.save();
    fs(c, lin(c, -22, 0, 22, 0, ['#ffb74d', '#fb8c00', '#c25400']), '#6e2c00', 2);
    c.clip();
    c.fillStyle = 'rgba(255,255,255,.85)';
    c.fillRect(-30, -22, 60, 6);
    c.fillRect(-30, -38, 60, 5);
    if (f < 0.67) { c.fillStyle = 'rgba(80,30,0,.4)'; ell(c, 8, -10, 6, 4, 0.4); c.fill(); ell(c, -10, -28, 4, 3); c.fill(); }
    c.restore();
    rrect(c, -27, -3, 54, 8, 3); fs(c, lin(c, 0, -3, 0, 5, ['#ff9a2a', '#c25400']), '#6e2c00', 1.8);
    c.restore();
}

function drawBucket(c, f) {
    c.save(); c.translate(1, -12); c.rotate(-0.07);
    c.beginPath();
    c.moveTo(-25, 6); c.lineTo(-18, -38);
    c.quadraticCurveTo(0, -42, 18, -38);
    c.lineTo(25, 6);
    c.quadraticCurveTo(0, 10, -25, 6);
    c.closePath();
    c.save();
    fs(c, lin(c, -25, 0, 25, 0, ['#7f868f', '#e8ecf0', '#b0b7bf', '#6a7079']), '#33373d', 2);
    c.clip();
    c.strokeStyle = 'rgba(60,64,70,.45)'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(-30, -12); c.quadraticCurveTo(0, -8, 30, -12); c.moveTo(-30, -26); c.quadraticCurveTo(0, -22, 30, -26); c.stroke();
    if (f < 0.67) { c.fillStyle = 'rgba(40,44,50,.5)'; ell(c, -6, -18, 7, 5, 0.5); c.fill(); c.fillStyle = 'rgba(255,255,255,.5)'; ell(c, -4, -20, 4, 2, 0.5); c.fill(); }
    if (f < 0.34) { c.fillStyle = 'rgba(40,44,50,.55)'; ell(c, 12, -6, 6, 6); c.fill(); ell(c, 4, -32, 5, 3); c.fill(); }
    c.restore();
    rrect(c, -28, 2, 56, 8, 4); fs(c, lin(c, -28, 0, 28, 0, ['#8a9199', '#d6dbe0', '#7a8189']), '#33373d', 1.6);
    ell(c, 0, -39, 18, 3.5); fs(c, '#9aa1a9', '#33373d', 1.4);
    c.restore();
}

function drawHelmet(c, f) {
    c.beginPath();
    c.ellipse(2, -5, 26.5, 27, 0, Math.PI * 0.93, Math.PI * 2.2);
    c.closePath();
    fs(c, rad(c, 2, -5, 28, ['#ff8a80', '#d32f2f', '#7f1010']), '#3e0808', 2.2);
    c.strokeStyle = '#ffffff'; c.lineWidth = 4;
    c.beginPath(); c.ellipse(2, -5, 26.5, 27, 0, Math.PI * 1.32, Math.PI * 1.62); c.stroke();
    if (f < 0.67) { c.fillStyle = 'rgba(60,0,0,.45)'; ell(c, 10, -20, 5, 4); c.fill(); }
    if (f < 0.34) { c.fillStyle = 'rgba(60,0,0,.5)'; ell(c, -10, -22, 6, 4); c.fill(); ell(c, 20, -2, 4, 5); c.fill(); }
    ell(c, 12, 2, 5, 6); fs(c, '#5a0a0a');
    // 面罩
    c.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
        c.beginPath();
        c.moveTo(-20, -12); c.quadraticCurveTo(-32, 0, -24, 18);
        c.moveTo(-22, 2); c.lineTo(-4, 4);
        c.moveTo(-24, 12); c.lineTo(-6, 14);
        c.lineWidth = pass ? 2.6 : 4.6; c.strokeStyle = pass ? '#cfd3d8' : '#444a52'; c.stroke();
    }
}

function drawFlag(c, z) {
    const t = z.t;
    c.save();
    c.lineCap = 'round';
    c.beginPath(); c.moveTo(-50, -78); c.lineTo(-46, -196);
    c.lineWidth = 5; c.strokeStyle = '#3a2410'; c.stroke();
    c.lineWidth = 3; c.strokeStyle = '#8a5a2b'; c.stroke();
    c.beginPath();
    const x0 = -46, y0 = -194, w = 58, h = 36;
    c.moveTo(x0, y0);
    for (let i = 0; i <= 8; i++) { const x = x0 + w * i / 8; c.lineTo(x, y0 + Math.sin(t * 5 - i * 0.8) * 3 * i / 8); }
    for (let i = 8; i >= 0; i--) {
        const x = x0 + w * i / 8;
        const rag = i === 8 ? 0 : (i % 2 ? 4 : 0);
        c.lineTo(x - rag * 0.3, y0 + h + Math.sin(t * 5 - i * 0.8) * 3 * i / 8 - rag);
    }
    c.closePath();
    fs(c, lin(c, x0, y0, x0 + w, y0 + h, ['#e53935', '#b71c1c', '#7f0000']), '#3a0000', 1.8);
    // 脑子图案
    const bx = x0 + w * 0.5, by = y0 + h * 0.5 + Math.sin(t * 5 - 3.2) * 1.5;
    ell(c, bx, by, 11, 8); fs(c, '#f8a5c2', '#7a2a44', 1.4);
    c.beginPath(); c.moveTo(bx, by - 8); c.lineTo(bx, by + 8);
    c.moveTo(bx - 8, by - 2); c.quadraticCurveTo(bx - 4, by - 5, bx - 3, by + 1);
    c.moveTo(bx + 8, by + 2); c.quadraticCurveTo(bx + 4, by - 3, bx + 3, by + 3);
    c.lineWidth = 1.2; c.strokeStyle = '#7a2a44'; c.stroke();
    c.restore();
}

// ======================================================================
// 其他物件绘制
// ======================================================================
function drawSun(c, x, y, s, t, alpha = 1) {
    c.save();
    c.translate(x, y); c.scale(s, s);
    c.globalAlpha *= alpha;
    c.fillStyle = rad(c, 0, 0, 50, ['rgba(255,240,140,.65)', 'rgba(255,220,60,.25)', 'rgba(255,200,40,0)'], 0, 0);
    circ(c, 0, 0, 50); c.fill();
    c.save(); c.rotate(t * 0.8);
    c.fillStyle = 'rgba(255,196,30,.85)';
    for (let i = 0; i < 12; i++) {
        c.rotate(TAU / 12);
        c.beginPath(); c.moveTo(-6, -20); c.lineTo(0, -36 - (i % 2) * 5); c.lineTo(6, -20); c.closePath(); c.fill();
    }
    c.restore();
    circ(c, 0, 0, 21);
    fs(c, rad(c, 0, 0, 21, ['#fffde8', '#ffe45c', '#f7a400']), '#e08a00', 1.6);
    ell(c, -7, -8, 6, 3.5, -0.6); fs(c, 'rgba(255,255,255,.7)');
    c.restore();
}

function drawPea(c, x, y, kind) {
    const snow = kind === 'snow';
    circ(c, x, y, 9.5);
    fs(c, rad(c, x, y, 10, snow ? ['#ffffff', '#9fe0ff', '#3a8ccc'] : ['#e2ff9e', '#6cd13a', '#2c7a14']), snow ? '#1f5a86' : '#1e5a0c', 1.6);
    ell(c, x - 3.2, y - 3.6, 3, 2, -0.6); fs(c, 'rgba(255,255,255,.75)');
}

function drawMower(c, m) {
    c.save();
    c.translate(m.x, m.y);
    const vib = m.active ? Math.sin(m.t * 60) * 1 : 0;
    c.translate(0, vib);
    ell(c, 0, 2, 32, 7); fs(c, 'rgba(0,0,0,.25)');
    c.lineCap = 'round';
    c.beginPath(); c.moveTo(-14, -24); c.lineTo(-34, -54); c.lineWidth = 5; c.strokeStyle = '#3a3a3a'; c.stroke();
    c.beginPath(); c.moveTo(-40, -54); c.lineTo(-28, -56); c.lineWidth = 7; c.strokeStyle = '#1e1e1e'; c.stroke();
    rrect(c, -26, -30, 50, 22, 8);
    fs(c, lin(c, 0, -30, 0, -8, ['#ff6b6b', '#d62828', '#8f1414']), '#4a0808', 2);
    rrect(c, -12, -42, 24, 14, 5); fs(c, lin(c, 0, -42, 0, -28, ['#9aa0a6', '#555b62']), '#2a2e33', 1.6);
    circ(c, 0, -46, 3.5); fs(c, '#333');
    c.fillStyle = 'rgba(255,255,255,.4)'; rrect(c, -20, -27, 30, 4, 2); c.fill();
    for (const wx of [-16, 16]) {
        c.save(); c.translate(wx, -6); c.rotate(m.active ? m.t * 20 : 0);
        circ(c, 0, 0, 9); fs(c, '#222', '#000', 1.5);
        circ(c, 0, 0, 4); fs(c, '#bfc4c9');
        c.fillStyle = '#666'; c.fillRect(-1, -8, 2, 5);
        c.restore();
    }
    c.restore();
}

function drawTrophy(c, x, y, t) {
    c.save();
    c.translate(x, y + Math.sin(t * 2.5) * 5);
    c.save(); c.rotate(t * 0.6);
    for (let i = 0; i < 14; i++) {
        c.rotate(TAU / 14);
        c.fillStyle = i % 2 ? 'rgba(255,240,150,.35)' : 'rgba(255,255,255,.2)';
        c.beginPath(); c.moveTo(0, 0); c.lineTo(-12, -110); c.lineTo(12, -110); c.closePath(); c.fill();
    }
    c.restore();
    c.fillStyle = rad(c, 0, 0, 70, ['rgba(255,240,150,.8)', 'rgba(255,220,80,0)'], 0, 0);
    circ(c, 0, 0, 70); c.fill();
    const gold = ['#fff6c0', '#ffd34d', '#c98a00'];
    c.lineWidth = 6; c.strokeStyle = '#c98a00';
    c.beginPath(); c.arc(-26, -14, 12, Math.PI * 0.5, Math.PI * 1.5); c.stroke();
    c.beginPath(); c.arc(26, -14, 12, -Math.PI * 0.5, Math.PI * 0.5); c.stroke();
    c.beginPath(); c.moveTo(-26, -30); c.lineTo(26, -30); c.quadraticCurveTo(26, 8, 0, 12); c.quadraticCurveTo(-26, 8, -26, -30); c.closePath();
    fs(c, lin(c, -26, 0, 26, 0, gold), '#8a5a00', 2.2);
    rrect(c, -5, 10, 10, 14, 2); fs(c, '#e0a820', '#8a5a00', 1.6);
    rrect(c, -20, 22, 40, 12, 3); fs(c, lin(c, 0, 22, 0, 34, ['#ffd34d', '#b07800']), '#8a5a00', 1.8);
    ell(c, -10, -18, 5, 9, 0.2); fs(c, 'rgba(255,255,255,.55)');
    c.restore();
}

function drawShovel(c, x, y, s = 1, rot = 0) {
    c.save(); c.translate(x, y); c.scale(s, s); c.rotate(rot);
    c.lineCap = 'round';
    c.beginPath(); c.moveTo(0, -30); c.lineTo(0, 6); c.lineWidth = 7; c.strokeStyle = '#5a3412'; c.stroke();
    c.lineWidth = 4; c.strokeStyle = '#c08040'; c.stroke();
    rrect(c, -10, -38, 20, 8, 3); fs(c, '#c08040', '#5a3412', 1.6);
    c.beginPath(); c.moveTo(-12, 4); c.lineTo(12, 4); c.lineTo(10, 24); c.quadraticCurveTo(0, 36, -10, 24); c.closePath();
    fs(c, lin(c, -12, 0, 12, 0, ['#8d949c', '#eef1f4', '#9aa1a8']), '#3a3e44', 1.8);
    c.restore();
}

// ======================================================================
// 游戏状态
// ======================================================================
const game = {
    state: 'menu', levelIdx: 0, L: null, t: 0, sun: 0, sunPulse: 0,
    grid: null, plants: [], zombies: [], peas: [], suns: [], parts: [], mowers: [],
    seeds: [], holding: null, wave: 0, nextWaveAt: 0, warned: false, queue: [],
    skySunAt: 0, shake: 0, banners: [], trophy: null, speed: 1, lastDeath: null,
    rowHeat: [0, 0, 0, 0, 0], introT: 0, endT: 0, flash: 0, finalShown: false,
};
const mouse = { x: -100, y: -100, inside: false };
let realT = 0;
const demo = { plants: [], zombies: [] };

function loadDone() {
    try { return JSON.parse(localStorage.getItem('pvz_web_done') || '[]'); } catch (e) { return []; }
}
function saveDone(arr) {
    try { localStorage.setItem('pvz_web_done', JSON.stringify(arr)); } catch (e) { /* 忽略 */ }
}

function makePlant(type, r, col) {
    const T = PT[type];
    const p = {
        type, r, col, x: colCenter(col), y: rowBase(r), hp: T.hp, maxHp: T.hp,
        t: rand(0, 10), seed: Math.random() * 10, pop: 1, hurt: 0, recoil: 0,
        timer: 0, glow: 0,
    };
    if (type === 'sunflower') p.timer = rand(5, 8);
    if (type === 'peashooter' || type === 'snowpea' || type === 'repeater') p.timer = rand(0.2, 0.8);
    if (type === 'potatomine') { p.armed = false; p.armT = 12; p.armK = 0; }
    if (type === 'cherrybomb') p.fuse = 0;
    if (type === 'chomper') { p.cState = 'idle'; p.bt = 0; p.chewT = 0; }
    return p;
}

function makeZombie(type, row, x) {
    const T = ZT[type];
    return {
        type, row, x: x ?? W + rand(25, 80), y: rowBase(row),
        hp: T.hp, maxHp: T.hp, armor: T.armor, maxArmor: T.armor || 1, armorType: T.armorType,
        speed: rand(T.speed[0], T.speed[1]), t: rand(0, 10), ph: rand(0, TAU),
        hit: 0, slow: 0, eating: false, chompT: 0, armLost: false, headless: false,
        dying: false, dt: 0, burnt: false, remove: false, v: Array.from({ length: 16 }, Math.random), palKey: type === 'football' ? 'football' : 'normal',
    };
}

function startLevel(idx) {
    SFX.init();
    const L = LEVELS[idx];
    Object.assign(game, {
        state: 'intro', levelIdx: idx, L, t: 0, sun: L.sun, sunPulse: 0,
        grid: Array.from({ length: G.rows }, () => Array(G.cols).fill(null)),
        plants: [], zombies: [], peas: [], suns: [], parts: [], banners: [],
        mowers: Array.from({ length: G.rows }, (_, r) => ({ r, x: G.x - 44, y: rowBase(r) + 4, active: false, gone: false, t: 0 })),
        seeds: L.plants.map(type => ({ type, cd: 0 })),
        holding: null, wave: 0, nextWaveAt: L.first, warned: false, queue: [],
        skySunAt: 5, shake: 0, trophy: null, lastDeath: null, rowHeat: [0, 0, 0, 0, 0],
        introT: 0, endT: 0, flash: 0, finalShown: false,
    });
    for (const s of game.seeds) if (s.type === 'cherrybomb' || s.type === 'potatomine') s.cd = PT[s.type].cd * 0.4;
    showOverlay(null);
    banner('准备…', '#fff4c0', 0.75, 64, 0);
    banner('就位…', '#fff4c0', 0.75, 64, 0.75);
    banner('种植物！', '#ff4a3a', 1.0, 96, 1.5);
    SFX.ready();
    setTimeout(() => SFX.ready(), 750);
    setTimeout(() => SFX.go(), 1500);
}

function banner(text, color, dur, size, delay = 0, sub = false) {
    game.banners.push({ text, color, dur, size, t: -delay, sub });
}

// ======================================================================
// 粒子
// ======================================================================
function part(o) { game.parts.push(Object.assign({ t: 0, life: 1, vx: 0, vy: 0, g: 0, rot: 0, vr: 0, size: 4, alpha: 1 }, o)); }

function splat(x, y, kind) {
    const cols = kind === 'snow' ? ['#e8f8ff', '#9fe0ff', '#5ab0e6'] : ['#c9ff8a', '#7ed448', '#3f9a20'];
    for (let i = 0; i < 7; i++) {
        const a = rand(-Math.PI * 0.8, Math.PI * 0.8) + Math.PI;
        const sp = rand(40, 160);
        part({ kind: 'dot', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 30, g: 300, life: rand(0.25, 0.45), size: rand(2, 4.5), color: pick(cols) });
    }
    part({ kind: 'ring', x, y, life: 0.2, size: 6, color: cols[1] });
}

function dirt(x, y, n = 10) {
    for (let i = 0; i < n; i++) {
        part({ kind: 'chunk', x: x + rand(-18, 18), y: y - rand(0, 6), vx: rand(-90, 90), vy: rand(-220, -90), g: 700, life: rand(0.5, 0.8), size: rand(3, 6), color: pick(['#7a5230', '#5c3a1c', '#9a6a3e']), vr: rand(-10, 10) });
    }
}

function boom(x, y, radius, kind = 'cherry') {
    SFX.boom();
    game.shake = Math.max(game.shake, kind === 'cherry' ? 16 : 10);
    game.flash = kind === 'cherry' ? 0.5 : 0.25;
    part({ kind: 'ring', x, y, life: 0.45, size: radius * 0.9, color: '#fff2b0', lw: 10 });
    part({ kind: 'glow', x, y, life: 0.35, size: radius * 1.1, color: '#fff6c8' });
    for (let i = 0; i < 34; i++) {
        const a = rand(0, TAU), sp = rand(60, radius * 3.2);
        part({ kind: 'fire', x: x + rand(-10, 10), y: y + rand(-10, 10), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.7 - 60, g: -40, life: rand(0.35, 0.8), size: rand(14, 30), color: pick(['#ffdd55', '#ff9a2a', '#ff5a1f', '#fff1a8']) });
    }
    for (let i = 0; i < 18; i++) {
        const a = rand(0, TAU), sp = rand(20, 110);
        part({ kind: 'smoke', x: x + rand(-30, 30), y: y + rand(-30, 20), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.5 - 40, life: rand(0.9, 1.6), size: rand(18, 34), color: pick(['#4a4440', '#6b625a', '#2e2a28']) });
    }
    dirt(x, y + 20, 16);
}

function zombieHeadParticle(z) {
    part({ kind: 'zhead', x: z.x - 2, y: z.y - 116, vx: rand(10, 70), vy: rand(-240, -160), g: 900, ground: z.y - 14, rot: 0, vr: rand(2, 6), life: 1.6, z: { palKey: z.palKey, slow: z.slow, armor: 0, maxArmor: 1, burnt: false, v: z.v, t: z.t } });
}

function dropArmor(z) {
    part({ kind: 'armor', armorType: z.armorType, x: z.x - 2, y: z.y - 140, vx: rand(30, 90), vy: rand(-220, -140), g: 900, ground: z.y - 10, rot: 0, vr: rand(3, 8), life: 1.4 });
    if (z.armorType === 'bucket' || z.armorType === 'helmet') SFX.metal(); else SFX.plastic();
}

// ======================================================================
// 逻辑
// ======================================================================
function liveZombies() { let n = 0; for (const z of game.zombies) if (!z.dying) n++; return n; }

function damageZombie(z, dmg, sound = true) {
    if (z.dying) return;
    z.hit = 0.1;
    if (z.armor > 0) {
        z.armor -= dmg;
        if (sound) { if (z.armorType === 'cone') SFX.plastic(); else SFX.metal(); }
        if (z.armor <= 0) { dmg = -z.armor; z.armor = 0; dropArmor(z); } else return;
    } else if (sound) SFX.hit();
    z.hp -= dmg;
    if (!z.armLost && z.hp < z.maxHp * 0.5) {
        z.armLost = true;
        part({ kind: 'zarm', x: z.x - 30, y: z.y - 90, vx: rand(-20, 30), vy: rand(-120, -60), g: 900, ground: z.y - 6, rot: 0.2, vr: rand(-6, 6), life: 1.4, pal: z.palKey, fb: z.type === 'football', zz: z });
    }
    if (z.hp <= 0) killZombie(z, 'normal');
}

function killZombie(z, how) {
    if (z.dying) return;
    z.dying = true; z.dt = 0; z.eating = false;
    game.lastDeath = { x: clamp(z.x, G.x + 40, G.x + G.cols * G.cw - 40), y: z.y - 50 };
    if (how === 'burn') { z.burnt = true; return; }
    if (how === 'eaten') { z.remove = true; return; }
    if (!z.headless) { z.headless = true; zombieHeadParticle(z); }
}

function burnArea(cx, cy, row0, row1, x0, x1) {
    for (const z of game.zombies) {
        if (z.dying || z.row < row0 || z.row > row1) continue;
        const zx = z.x - 10;
        if (zx >= x0 && zx <= x1 && z.x < W + 30) {
            z.armor = 0; z.hp = 0;
            killZombie(z, 'burn');
        }
    }
}

function plantAt(r, col) { return game.grid[r] ? game.grid[r][col] : null; }

function removePlant(p) {
    if (game.grid[p.r][p.col] === p) game.grid[p.r][p.col] = null;
    p.dead = true;
    game.plants = game.plants.filter(q => q !== p);
}

function zombieAhead(r, x) {
    for (const z of game.zombies) if (!z.dying && z.row === r && z.x > x - 20 && z.x < W - 20) return true;
    return false;
}

function updatePlants(dt) {
    for (const p of game.plants.slice()) {
        p.t += dt;
        p.pop = Math.max(0, p.pop - dt * 3.2);
        p.hurt = Math.max(0, p.hurt - dt);
        p.recoil = Math.max(0, p.recoil - dt * 6);
        switch (p.type) {
            case 'sunflower':
                p.timer -= dt;
                p.glow = p.timer < 1 ? 1 - Math.max(0, p.timer) : Math.max(0, p.glow - dt * 2);
                if (p.timer <= 0) {
                    p.timer = 24;
                    spawnSun(p.x + rand(-10, 10), p.y - 70, 'pop', p.y - rand(18, 40));
                }
                break;
            case 'peashooter': case 'snowpea': case 'repeater':
                p.timer -= dt;
                if (p.pending != null) {
                    p.pending -= dt;
                    if (p.pending <= 0) { firePea(p); p.pending = null; }
                }
                if (p.timer <= 0 && zombieAhead(p.r, p.x)) {
                    p.timer = 1.42;
                    firePea(p);
                    if (p.type === 'repeater') p.pending = 0.16;
                }
                break;
            case 'potatomine':
                if (!p.armed) {
                    p.armT -= dt;
                    if (p.armT <= 0) { p.armed = true; p.armK = 0; dirt(p.x, p.y, 8); SFX.arm(); }
                } else {
                    p.armK = Math.min(1, p.armK + dt * 3);
                    for (const z of game.zombies) {
                        if (z.dying || z.row !== p.r) continue;
                        if (Math.abs(z.x - 24 - p.x) < 42) {
                            boom(p.x, p.y - 20, 70, 'potato');
                            burnArea(p.x, p.y, p.r, p.r, p.x - 70, p.x + 85);
                            part({ kind: 'word', x: p.x, y: p.y - 60, text: '嘭！', life: 1.1, size: 46, color: '#ffe082' });
                            removePlant(p);
                            break;
                        }
                    }
                }
                break;
            case 'cherrybomb':
                p.fuse += dt / 1.1;
                if (p.fuse >= 1) {
                    boom(p.x, p.y - 30, 150, 'cherry');
                    burnArea(p.x, p.y, p.r - 1, p.r + 1, p.x - 160, p.x + 160);
                    removePlant(p);
                }
                break;
            case 'chomper':
                if (p.cState === 'idle') {
                    let target = null;
                    for (const z of game.zombies) {
                        if (z.dying || z.row !== p.r) continue;
                        const d = z.x - p.x;
                        if (d > -10 && d < 135 && (!target || z.x < target.x)) target = z;
                    }
                    if (target) { p.cState = 'bite'; p.bt = 0; p.target = target; }
                } else if (p.cState === 'bite') {
                    p.bt += dt;
                    if (p.bt >= 0.28 && p.target) {
                        const z = p.target; p.target = null;
                        const d = z.x - p.x;
                        if (!z.dying && d > -20 && d < 150) {
                            killZombie(z, 'eaten');
                            SFX.chomp(); SFX.gulp();
                            for (let i = 0; i < 8; i++) part({ kind: 'dot', x: p.x + 50, y: p.y - 70 + rand(-15, 15), vx: rand(-60, 80), vy: rand(-140, -40), g: 500, life: 0.5, size: rand(2, 4), color: pick(['#97a183', '#5b4b3b', '#41475c', '#5e1a14']) });
                            p.chewing = true;
                        }
                    }
                    if (p.bt >= 0.45) {
                        if (p.chewing) { p.cState = 'chew'; p.chewT = 22; p.chewing = false; }
                        else p.cState = 'idle';
                    }
                } else if (p.cState === 'chew') {
                    p.chewT -= dt;
                    if (p.chewT <= 0) { p.cState = 'idle'; SFX.gulp(); }
                }
                break;
        }
    }
}

function firePea(p) {
    const kind = p.type === 'snowpea' ? 'snow' : 'pea';
    game.peas.push({ x: p.x + 38, y: p.y - 54, r: p.r, kind, t: 0 });
    p.recoil = 1;
    SFX.shoot();
}

function updatePeas(dt) {
    for (const pe of game.peas) {
        pe.x += 430 * dt; pe.t += dt;
        if (pe.kind === 'snow' && Math.random() < dt * 25) {
            part({ kind: 'flake', x: pe.x - 6, y: pe.y + rand(-5, 5), vx: rand(-30, -10), vy: rand(-10, 10), life: 0.4, size: rand(1.5, 3), color: '#e8f8ff' });
        }
        let hitZ = null;
        for (const z of game.zombies) {
            if (z.dying || z.row !== pe.r || z.x > W - 10) continue;
            if (pe.x >= z.x - 26 && pe.x <= z.x + 28 && (!hitZ || z.x < hitZ.x)) hitZ = z;
        }
        if (hitZ) {
            damageZombie(hitZ, 20);
            if (pe.kind === 'snow') {
                if (hitZ.slow <= 0) for (let i = 0; i < 4; i++) part({ kind: 'flake', x: hitZ.x + rand(-15, 15), y: hitZ.y - rand(40, 120), vx: 0, vy: rand(-20, 20), life: 0.6, size: 3, color: '#cfefff' });
                hitZ.slow = 10;
            }
            splat(pe.x, pe.y, pe.kind);
            pe.dead = true;
        } else if (pe.x > W + 20) pe.dead = true;
    }
    game.peas = game.peas.filter(p => !p.dead);
}

function biteTarget(z) {
    const bx = z.x - 24;
    let best = null;
    for (let col = G.cols - 1; col >= 0; col--) {
        const p = game.grid[z.row][col];
        if (!p) continue;
        if (p.type === 'potatomine' && p.armed) continue;
        if (bx < p.x + 34 && bx > p.x - 46) { best = p; break; }
    }
    return best;
}

function updateZombies(dt) {
    for (const z of game.zombies) {
        z.t += dt;
        z.hit = Math.max(0, z.hit - dt);
        z.slow = Math.max(0, z.slow - dt);
        if (z.dying) {
            z.dt += dt;
            if (z.burnt && z.dt > 0.9 && !z.ashed) {
                z.ashed = true;
                for (let i = 0; i < 26; i++) part({ kind: 'dot', x: z.x + rand(-20, 20), y: z.y - rand(0, 130), vx: rand(-30, 30), vy: rand(-40, 20), g: 260, ground: z.y, life: rand(0.6, 1.1), size: rand(2, 4.5), color: pick(['#2a2420', '#3d3530', '#151210']) });
            }
            if (z.dt > (z.burnt ? 1.35 : 1.7)) z.remove = true;
            continue;
        }
        const sf = z.slow > 0 ? 0.5 : 1;
        const target = biteTarget(z);
        if (target) {
            z.eating = true;
            target.hp -= 100 * dt * sf;
            target.hurt = 0.08;
            z.chompT -= dt;
            if (z.chompT <= 0) { z.chompT = 0.5 / sf; SFX.chomp(); }
            if (target.hp <= 0) { removePlant(target); SFX.gulp(); }
        } else {
            z.eating = false;
            z.x -= z.speed * dt * sf;
            z.ph += dt * (z.type === 'football' ? 7 : 3.2) * sf;
        }
        if (Math.random() < dt * 0.04) SFX.groan();
        if (z.x < G.x - 74) {
            loseGame();
            return;
        }
    }
    game.zombies = game.zombies.filter(z => !z.remove);
}

function updateMowers(dt) {
    for (const m of game.mowers) {
        if (m.gone) continue;
        m.t += dt;
        if (!m.active) {
            for (const z of game.zombies) {
                if (!z.dying && z.row === m.r && z.x < G.x + 4) { m.active = true; SFX.mower(); break; }
            }
        } else {
            m.x += 460 * dt;
            if (Math.random() < dt * 30) part({ kind: 'smoke', x: m.x - 30, y: m.y - 30, vx: rand(-60, -20), vy: rand(-30, -10), life: 0.6, size: rand(6, 12), color: '#cfcfcf' });
            for (const z of game.zombies) {
                if (!z.dying && z.row === m.r && z.x - 30 < m.x + 28 && z.x > m.x - 40) {
                    z.armor = 0; z.hp = 0;
                    killZombie(z, 'normal');
                    for (let i = 0; i < 6; i++) part({ kind: 'dot', x: z.x, y: z.y - rand(20, 80), vx: rand(40, 160), vy: rand(-160, -40), g: 600, life: 0.6, size: rand(2, 4), color: pick(['#97a183', '#5b4b3b', '#41475c', '#5e1a14']) });
                }
            }
            if (m.x > W + 60) m.gone = true;
        }
    }
}

function spawnSun(x, y, mode, ty) {
    game.suns.push({ x, y, ty, mode, vx: mode === 'pop' ? rand(-40, 40) : 0, vy: mode === 'pop' ? -230 : 62, life: 9, t: rand(0, 3), value: 25, s: mode === 'pop' ? 0.4 : 1 });
}

function updateSuns(dt) {
    for (const s of game.suns) {
        s.t += dt;
        if (s.mode === 'fall') {
            s.y += s.vy * dt;
            if (s.y >= s.ty) { s.y = s.ty; s.mode = 'ground'; }
        } else if (s.mode === 'pop') {
            s.s = Math.min(1, s.s + dt * 3);
            s.vy += 560 * dt; s.x += s.vx * dt; s.y += s.vy * dt;
            if (s.vy > 0 && s.y >= s.ty) { s.y = s.ty; s.mode = 'ground'; }
        } else if (s.mode === 'ground') {
            s.life -= dt;
            if (s.life <= 0) s.dead = true;
        } else if (s.mode === 'collect') {
            const k = 1 - Math.pow(0.0008, dt);
            s.x = lerp(s.x, SUN_POS.x, k);
            s.y = lerp(s.y, SUN_POS.y, k);
            s.s = Math.max(0.55, s.s - dt);
            if (Math.hypot(s.x - SUN_POS.x, s.y - SUN_POS.y) < 12) {
                s.dead = true; game.sun = Math.min(9990, game.sun + s.value); game.sunPulse = 0.35;
            }
        }
    }
    game.suns = game.suns.filter(s => !s.dead);
}

function collectSun(s) {
    if (s.mode === 'collect') return;
    s.mode = 'collect';
    SFX.sun();
}

function updateWaves(dt) {
    const L = game.L;
    if (game.state !== 'play') return;
    if (game.t >= game.skySunAt) {
        game.skySunAt = game.t + rand(8.5, 12);
        spawnSun(rand(G.x + 30, G.x + G.cols * G.cw - 30), -40, 'fall', rowBase(randi(0, 4)) - rand(20, 50));
    }
    if (game.wave < L.waves) {
        const nextHuge = L.huge.includes(game.wave + 1);
        if (game.wave > 0 && liveZombies() === 0 && game.queue.length === 0 && game.nextWaveAt - game.t > 6) game.nextWaveAt = game.t + 6;
        if (nextHuge && !game.warned && game.t >= game.nextWaveAt - 4.5) {
            game.warned = true;
            banner('一大波僵尸正在接近！', '#ff3b30', 3.6, 58);
            SFX.siren();
        }
        if (game.t >= game.nextWaveAt) spawnWave();
    }
    for (let i = game.queue.length - 1; i >= 0; i--) {
        const q = game.queue[i];
        if (game.t >= q.at) {
            game.zombies.push(makeZombie(q.type, pickRow()));
            game.queue.splice(i, 1);
        }
    }
}

function pickRow() {
    const w = game.rowHeat.map(h => 1 / (1 + h * 1.5));
    let sum = w.reduce((a, b) => a + b, 0), x = Math.random() * sum, r = 0;
    for (; r < 4; r++) { x -= w[r]; if (x <= 0) break; }
    game.rowHeat = game.rowHeat.map(h => h * 0.55);
    game.rowHeat[r] += 1;
    return r;
}

function spawnWave() {
    const L = game.L;
    game.wave++;
    game.warned = false;
    const i = game.wave, huge = L.huge.includes(i);
    let budget = L.base + i * L.grow;
    if (huge) budget = budget * 2 + 2;
    budget = Math.max(1, Math.round(budget));
    const list = [];
    if (huge) list.push('flag');
    const pool = L.zombies.filter(k => ZT[k].minWave <= i);
    while (budget > 0) {
        const cands = pool.filter(k => ZT[k].cost <= budget);
        if (!cands.length) break;
        let tot = cands.reduce((a, k) => a + ZT[k].weight, 0), x = Math.random() * tot, k = cands[0];
        for (const c of cands) { x -= ZT[c].weight; if (x <= 0) { k = c; break; } }
        list.push(k);
        budget -= ZT[k].cost;
    }
    let d = 0;
    for (const k of list) {
        game.queue.push({ at: game.t + d, type: k });
        d += huge ? rand(0.15, 0.6) : rand(0.8, 2.6);
    }
    game.nextWaveAt = game.t + (huge ? 34 : 25) + d * 0.5;
    if (i === 1) SFX.groan();
    if (i === L.waves) { banner('最后一波！', '#ff3b30', 2.4, 84); game.finalShown = true; }
}

function loseGame() {
    if (game.state !== 'play') return;
    game.state = 'lost';
    game.holding = null;
    game.shake = 10;
    SFX.lose();
    setTimeout(() => showOverlay('lose'), 900);
}

function checkWin() {
    if (game.state !== 'play' || game.trophy) return;
    if (game.wave >= game.L.waves && game.queue.length === 0 && game.zombies.length === 0) {
        const pos = game.lastDeath || { x: G.x + 500, y: G.y + 250 };
        game.trophy = { x: pos.x, y: pos.y, t: 0 };
        SFX.pop();
    }
}

function claimTrophy() {
    if (game.state !== 'play') return;
    game.state = 'won';
    game.holding = null;
    SFX.win();
    for (let i = 0; i < 60; i++) {
        const a = rand(0, TAU), sp = rand(80, 380);
        part({ kind: 'dot', x: game.trophy.x, y: game.trophy.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120, g: 400, life: rand(0.8, 1.6), size: rand(3, 6), color: pick(['#ffd34d', '#fff6c0', '#7ee2b8', '#ff8a80', '#8fd3ff']) });
    }
    const done = loadDone();
    if (!done.includes(game.levelIdx)) { done.push(game.levelIdx); saveDone(done); }
    const last = game.levelIdx >= LEVELS.length - 1;
    document.getElementById('winText').textContent = last
        ? '恭喜通关全部关卡！你的草坪坚不可摧！'
        : `关卡 1-${game.levelIdx + 1} 完成！下一关：${LEVELS[game.levelIdx + 1].name}`;
    document.querySelector('#win [data-act="next"]').style.display = last ? 'none' : '';
    setTimeout(() => { showOverlay('win'); buildLevelCards(); }, 1300);
}

function updateParts(dt) {
    for (const p of game.parts) {
        p.t += dt;
        p.vy += p.g * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.rot += p.vr * dt;
        if (p.ground != null && p.y > p.ground) {
            p.y = p.ground;
            if (p.vy > 120) { p.vy *= -0.3; p.vx *= 0.5; p.vr *= 0.4; } else { p.vy = 0; p.vx *= 0.8; p.vr = 0; }
        }
        if (p.kind === 'fire' || p.kind === 'smoke') { p.vx *= 1 - dt * 2.5; p.vy *= 1 - dt * 2.5; }
    }
    game.parts = game.parts.filter(p => p.t < p.life);
}

function update(dt) {
    realT += dt;
    for (const b of game.banners) b.t += dt;
    game.banners = game.banners.filter(b => b.t < b.dur);
    game.shake = Math.max(0, game.shake - dt * 30);
    game.flash = Math.max(0, game.flash - dt * 1.6);
    game.sunPulse = Math.max(0, game.sunPulse - dt);

    if (game.state === 'menu') {
        for (const p of demo.plants) { p.t += dt; p.recoil = Math.max(0, p.recoil - dt * 6); if (p.shooter && (p.timer -= dt) < 0) { p.timer = 1.5; p.recoil = 1; } }
        for (const z of demo.zombies) { z.t += dt; z.ph += dt * 3.2; }
        return;
    }
    if (game.state === 'paused') return;

    const sdt = dt * game.speed;
    if (game.state === 'intro') {
        game.introT += dt;
        for (const p of game.plants) p.t += dt;
        if (game.introT > 2.5) game.state = 'play';
        return;
    }
    if (game.state === 'play') {
        game.t += sdt;
        for (const s of game.seeds) s.cd = Math.max(0, s.cd - sdt);
        updateWaves(sdt);
        updatePlants(sdt);
        updateZombies(sdt);
        updatePeas(sdt);
        updateMowers(sdt);
        updateSuns(sdt);
        if (game.trophy) game.trophy.t += sdt;
        checkWin();
    } else {
        // 胜利 / 失败后继续播放动画
        for (const z of game.zombies) { z.t += dt; if (!z.dying) { z.ph += dt * 3.2; if (game.state === 'lost') z.x -= z.speed * dt; } }
        for (const p of game.plants) p.t += dt;
        updateSuns(dt);
        if (game.trophy) game.trophy.t += dt;
    }
    updateParts(sdt);
}

// ======================================================================
// 渲染
// ======================================================================
const BANK = { x: 8, y: 6, h: 108, sunW: 96, slot: 72, pw: 64, ph: 88 };
function bankWidth() { return BANK.sunW + game.seeds.length * BANK.slot + 12; }
function packetRect(i) { return { x: BANK.x + BANK.sunW + 6 + i * BANK.slot, y: BANK.y + 10, w: BANK.pw, h: BANK.ph }; }
function shovelRect() { return { x: BANK.x + bankWidth() + 10, y: BANK.y + 14, w: 80, h: 80 }; }
const BTNS = [
    { id: 'pause', x: W - 46, y: 40, r: 26 },
    { id: 'speed', x: W - 108, y: 40, r: 26 },
    { id: 'sound', x: W - 170, y: 40, r: 26 },
];

function render() {
    const c = ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.setTransform(S, 0, 0, S, 0, 0);
    c.save();
    if (game.shake > 0) c.translate(rand(-1, 1) * game.shake, rand(-1, 1) * game.shake);
    c.drawImage(bg, 0, 0, W, H);

    if (game.state === 'menu') {
        renderWorld(c, demo.plants, demo.zombies, [], []);
        c.restore();
        return;
    }

    // 种植预览高亮
    const cell = hoverCell();
    if (cell && game.holding && game.state === 'play') {
        const x = G.x + cell.col * G.cw, y = G.y + cell.r * G.ch;
        c.fillStyle = 'rgba(255,255,255,.12)';
        c.fillRect(G.x, y, G.cols * G.cw, G.ch);
        rrect(c, x + 3, y + 3, G.cw - 6, G.ch - 6, 10);
        fs(c, 'rgba(255,255,255,.22)', 'rgba(255,255,255,.6)', 2);
    }

    for (const m of game.mowers) if (!m.gone) drawMower(c, m);
    renderWorld(c, game.plants, game.zombies, game.peas, game.parts);

    // 阳光
    for (const s of game.suns) {
        const a = s.mode === 'ground' && s.life < 2 ? (Math.sin(s.life * 18) > 0 ? 1 : 0.35) : 1;
        const hover = s.mode !== 'collect' && Math.hypot(mouse.x - s.x, mouse.y - s.y) < 40;
        drawSun(c, s.x, s.y, s.s * (hover ? 1.12 : 1), s.t, a);
    }
    if (game.trophy) drawTrophy(c, game.trophy.x, game.trophy.y, game.trophy.t);
    c.restore();

    if (game.flash > 0) { c.fillStyle = `rgba(255,250,220,${game.flash * 0.6})`; c.fillRect(0, 0, W, H); }

    renderUI(c);
    renderBanners(c);
    renderCursor(c, cell);
}

function renderWorld(c, plants, zombies, peas, parts) {
    const rows = Array.from({ length: G.rows }, () => ({ p: [], z: [], pe: [] }));
    for (const p of plants) rows[p.r].p.push(p);
    for (const z of zombies) if (z.row >= 0 && z.row < G.rows) rows[z.row].z.push(z);
    for (const pe of peas) rows[pe.r].pe.push(pe);
    for (let r = 0; r < G.rows; r++) {
        const R = rows[r];
        c.fillStyle = 'rgba(0,30,0,.22)';
        for (const p of R.p) { ell(c, p.x, p.y - 1, p.type === 'wallnut' ? 32 : 28, 8); c.fill(); }
        for (const z of R.z) if (!(z.dying && z.dt > 0.8)) { ell(c, z.x + 2, z.y, 30, 8); c.fill(); }
        R.p.sort((a, b) => a.col - b.col);
        for (const p of R.p) renderPlant(c, p);
        R.z.sort((a, b) => b.x - a.x);
        for (const z of R.z) renderZombie(c, z);
        for (const pe of R.pe) {
            ell(c, pe.x, rowBase(r) - 2, 7, 3); fs(c, 'rgba(0,30,0,.2)');
            drawPea(c, pe.x, pe.y, pe.kind);
        }
    }
    renderParts(c, parts);
}

function renderPlant(c, p, alpha = 1) {
    c.save();
    c.translate(p.x, p.y);
    if (alpha < 1) c.globalAlpha = alpha;
    if (p.pop > 0) {
        const k = easeOutBack(1 - p.pop);
        c.scale(0.6 + 0.4 * k + p.pop * 0.1, 0.4 + 0.6 * k);
    }
    DRAW_PLANT[p.type](c, p);
    if (p.hurt > 0 || p.glowHit) {
        c.globalCompositeOperation = 'lighter';
        c.globalAlpha = 0.28;
        DRAW_PLANT[p.type](c, p);
    }
    c.restore();
}

function renderZombie(c, z) {
    c.save();
    c.translate(z.x, z.y);
    if (z.dying && !z.burnt) {
        const k = clamp(z.dt / 0.75, 0, 1);
        c.translate(10 * k, 0);
        c.rotate(k * k * 1.45);
        if (z.dt > 1.1) c.globalAlpha = clamp(1 - (z.dt - 1.1) / 0.6, 0, 1);
    }
    if (z.burnt && z.dt > 0.85) c.globalAlpha = clamp(1 - (z.dt - 0.85) / 0.45, 0, 1);
    drawZombie(c, z);
    if (z.hit > 0 && !z.dying) {
        c.globalCompositeOperation = 'lighter';
        c.globalAlpha = 0.32;
        drawZombie(c, z);
    }
    c.restore();
}

function renderParts(c, parts) {
    for (const p of parts) {
        const k = p.t / p.life;
        c.save();
        switch (p.kind) {
            case 'dot': case 'flake':
                c.globalAlpha = 1 - k * k;
                circ(c, p.x, p.y, p.size * (p.kind === 'flake' ? 1 : 1 - k * 0.3)); fs(c, p.color);
                break;
            case 'chunk':
                c.globalAlpha = 1 - k * k;
                c.translate(p.x, p.y); c.rotate(p.rot);
                c.fillStyle = p.color; c.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
                break;
            case 'ring':
                c.globalAlpha = 1 - k;
                c.beginPath(); c.arc(p.x, p.y, p.size * (0.4 + k * 1.6), 0, TAU);
                c.lineWidth = (p.lw || 3) * (1 - k); c.strokeStyle = p.color; c.stroke();
                break;
            case 'glow':
                c.globalCompositeOperation = 'lighter';
                c.globalAlpha = 1 - k;
                c.fillStyle = rad(c, p.x, p.y, p.size, ['rgba(255,250,210,.95)', 'rgba(255,200,80,.5)', 'rgba(255,120,20,0)'], 0, 0);
                circ(c, p.x, p.y, p.size); c.fill();
                break;
            case 'fire':
                c.globalCompositeOperation = 'lighter';
                c.globalAlpha = (1 - k) * 0.9;
                c.fillStyle = rad(c, p.x, p.y, p.size * (1 + k), [p.color, rgba(p.color, 0)], 0, 0);
                circ(c, p.x, p.y, p.size * (1 + k)); c.fill();
                break;
            case 'smoke':
                c.globalAlpha = (1 - k) * 0.55;
                circ(c, p.x, p.y, p.size * (0.6 + k)); fs(c, p.color);
                break;
            case 'word': {
                const s = k < 0.15 ? easeOutBack(k / 0.15) : 1;
                c.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
                c.translate(p.x, p.y - k * 30); c.scale(s, s); c.rotate(-0.08);
                c.font = `${p.size}px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
                c.lineWidth = 8; c.strokeStyle = '#5a1a00'; c.lineJoin = 'round'; c.strokeText(p.text, 0, 0);
                c.fillStyle = p.color; c.fillText(p.text, 0, 0);
                break;
            }
            case 'zhead': {
                c.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
                c.translate(p.x, p.y); c.rotate(p.rot);
                const P = p.z.slow > 0 ? PALS[p.z.palKey].s : PALS[p.z.palKey].n;
                drawZHead(c, P, p.z, 0.6);
                break;
            }
            case 'zarm': {
                c.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
                c.translate(p.x, p.y); c.rotate(p.rot);
                drawZArm(c, PALS[p.pal].n, 20, 0, 0, true, p.fb, p.zz);
                break;
            }
            case 'armor': {
                c.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
                c.translate(p.x, p.y); c.rotate(p.rot);
                if (p.armorType === 'cone') drawCone(c, 0.2);
                else if (p.armorType === 'bucket') drawBucket(c, 0.2);
                else drawHelmet(c, 0.2);
                break;
            }
        }
        c.restore();
    }
}

function woodPanel(c, x, y, w, h, r = 12) {
    rrect(c, x, y + 4, w, h, r); fs(c, 'rgba(0,0,0,.3)');
    rrect(c, x, y, w, h, r);
    fs(c, lin(c, 0, y, 0, y + h, ['#b47a3f', '#93602c', '#6e4419']), '#3e240a', 3);
    c.save(); rrect(c, x, y, w, h, r); c.clip();
    c.strokeStyle = 'rgba(60,30,5,.18)'; c.lineWidth = 1.2;
    for (let yy = y + 10; yy < y + h; yy += 13) { c.beginPath(); c.moveTo(x, yy); c.bezierCurveTo(x + w * 0.3, yy - 3, x + w * 0.6, yy + 3, x + w, yy); c.stroke(); }
    c.fillStyle = 'rgba(255,230,180,.25)'; c.fillRect(x, y, w, 3);
    c.restore();
}

function renderUI(c) {
    const bw = bankWidth();
    woodPanel(c, BANK.x, BANK.y, bw, BANK.h, 14);
    // 阳光槽
    rrect(c, BANK.x + 10, BANK.y + 10, 80, 88, 10);
    fs(c, lin(c, 0, BANK.y + 10, 0, BANK.y + 98, ['#5a3615', '#3e240a']), '#2a1604', 2);
    const pulse = game.sunPulse > 0 ? 1 + Math.sin(game.sunPulse / 0.35 * Math.PI) * 0.15 : 1;
    drawSun(c, SUN_POS.x, SUN_POS.y, 0.78 * pulse, realT);
    rrect(c, BANK.x + 16, BANK.y + 72, 68, 22, 8); fs(c, '#fff3d6', '#8a5a2b', 1.6);
    c.font = `22px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#3a2004'; c.fillText(String(game.sun), BANK.x + 50, BANK.y + 84);

    // 卡片
    let hoverIdx = -1;
    game.seeds.forEach((s, i) => {
        const R = packetRect(i);
        const T = PT[s.type];
        const held = game.holding && game.holding.kind === 'seed' && game.holding.idx === i;
        const hov = inRect(mouse, R) && game.state === 'play';
        if (hov) hoverIdx = i;
        const lift = hov && !held ? -3 : 0;
        c.save();
        c.translate(0, lift);
        rrect(c, R.x, R.y + 3, R.w, R.h, 8); fs(c, 'rgba(0,0,0,.35)');
        rrect(c, R.x, R.y, R.w, R.h, 8);
        fs(c, lin(c, 0, R.y, 0, R.y + R.h, ['#fffbe9', '#efe2b4', '#d9c58c']), '#5a3a14', 2);
        rrect(c, R.x + 5, R.y + 5, R.w - 10, R.h - 30, 6);
        fs(c, lin(c, 0, R.y, 0, R.y + R.h - 25, ['#a5e0f5', '#d8f2c4']), 'rgba(90,60,20,.4)', 1);
        c.save();
        rrect(c, R.x + 5, R.y + 5, R.w - 10, R.h - 30, 6); c.clip();
        c.translate(R.x + R.w / 2, R.y + R.h - 28);
        c.scale(0.52, 0.52);
        if (s.type === 'chomper') c.translate(-12, 18);
        if (s.type === 'cherrybomb') c.translate(0, 8);
        if (s.type === 'potatomine') c.translate(0, -14), c.scale(1.2, 1.2);
        if (s.type === 'wallnut') c.translate(0, 6);
        if (s.type.endsWith('shooter') || s.type === 'snowpea' || s.type === 'repeater') c.translate(-10, 4);
        if (s.type === 'sunflower') c.translate(0, 18);
        DRAW_PLANT[s.type](c, portraitOf(s.type));
        c.restore();
        c.font = `18px ${FONT}`; c.fillStyle = '#3a2004'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(String(T.cost), R.x + R.w / 2, R.y + R.h - 12);
        const cant = game.sun < T.cost;
        if (s.cd > 0) {
            const f = s.cd / T.cd;
            c.fillStyle = 'rgba(30,20,10,.55)';
            rrect(c, R.x, R.y, R.w, R.h, 8); c.save(); c.clip();
            c.fillRect(R.x, R.y, R.w, R.h * f);
            c.fillStyle = 'rgba(30,20,10,.25)'; c.fillRect(R.x, R.y, R.w, R.h);
            c.restore();
        } else if (cant || held) {
            rrect(c, R.x, R.y, R.w, R.h, 8); fs(c, held ? 'rgba(20,20,20,.5)' : 'rgba(30,20,10,.4)');
        }
        c.font = `12px ${FONT}`; c.fillStyle = 'rgba(60,30,0,.55)'; c.textAlign = 'left';
        c.fillText(String(i + 1), R.x + 6, R.y + 13);
        c.restore();
    });

    // 铲子
    const SR = shovelRect();
    rrect(c, SR.x, SR.y + 3, SR.w, SR.h, 12); fs(c, 'rgba(0,0,0,.3)');
    rrect(c, SR.x, SR.y, SR.w, SR.h, 12);
    fs(c, lin(c, 0, SR.y, 0, SR.y + SR.h, ['#7a4a1e', '#4e2c0c']), '#2a1604', 3);
    rrect(c, SR.x + 6, SR.y + 6, SR.w - 12, SR.h - 12, 9); fs(c, 'rgba(0,0,0,.25)');
    if (!(game.holding && game.holding.kind === 'shovel')) drawShovel(c, SR.x + SR.w / 2, SR.y + SR.h / 2 - 2, 1, 0.6);

    // 按钮
    for (const b of BTNS) {
        const hov = Math.hypot(mouse.x - b.x, mouse.y - b.y) < b.r;
        circ(c, b.x, b.y + 3, b.r); fs(c, 'rgba(0,0,0,.35)');
        circ(c, b.x, b.y, b.r);
        fs(c, rad(c, b.x, b.y, b.r, hov ? ['#d8a060', '#a8702f', '#6e4419'] : ['#c48a4a', '#93602c', '#5e3812']), '#3e240a', 3);
        c.fillStyle = '#fff4dc'; c.strokeStyle = '#fff4dc'; c.lineWidth = 3.5; c.lineCap = 'round'; c.lineJoin = 'round';
        if (b.id === 'pause') { c.fillRect(b.x - 8, b.y - 10, 5.5, 20); c.fillRect(b.x + 2.5, b.y - 10, 5.5, 20); }
        if (b.id === 'speed') {
            for (const o of [-6, 5]) { c.beginPath(); c.moveTo(b.x + o - 6, b.y - 9); c.lineTo(b.x + o + 4, b.y); c.lineTo(b.x + o - 6, b.y + 9); c.closePath(); c.fill(); }
            if (game.speed > 1) { c.font = `13px ${FONT}`; c.textAlign = 'center'; c.fillStyle = '#ffe066'; c.fillText('2x', b.x, b.y + 19); }
        }
        if (b.id === 'sound') {
            c.beginPath(); c.moveTo(b.x - 12, b.y - 5); c.lineTo(b.x - 6, b.y - 5); c.lineTo(b.x + 1, b.y - 11); c.lineTo(b.x + 1, b.y + 11); c.lineTo(b.x - 6, b.y + 5); c.lineTo(b.x - 12, b.y + 5); c.closePath(); c.fill();
            if (SFX.muted) { c.beginPath(); c.moveTo(b.x + 5, b.y - 6); c.lineTo(b.x + 13, b.y + 6); c.moveTo(b.x + 13, b.y - 6); c.lineTo(b.x + 5, b.y + 6); c.stroke(); }
            else { c.beginPath(); c.arc(b.x + 3, b.y, 7, -0.9, 0.9); c.stroke(); c.beginPath(); c.arc(b.x + 3, b.y, 12, -0.9, 0.9); c.stroke(); }
        }
    }

    // 关卡进度
    const L = game.L;
    const px = W - 330, py = 86, pw = 290, ph = 20;
    c.font = `20px ${FONT}`; c.textAlign = 'right'; c.textBaseline = 'middle';
    c.lineWidth = 5; c.strokeStyle = 'rgba(40,20,0,.75)'; c.lineJoin = 'round';
    const label = `关卡 1-${game.levelIdx + 1} · ${L.name}`;
    c.strokeText(label, W - 200, 40); c.fillStyle = '#fff4dc'; c.fillText(label, W - 200, 40);
    rrect(c, px - 4, py - 4, pw + 8, ph + 8, 10); fs(c, '#3e240a');
    rrect(c, px, py, pw, ph, 7); fs(c, lin(c, 0, py, 0, py + ph, ['#2a3a1a', '#3d5222']));
    const prog = clamp(game.wave / L.waves, 0, 1);
    if (prog > 0) {
        rrect(c, px + pw * (1 - prog), py, pw * prog, ph, 7);
        fs(c, lin(c, 0, py, 0, py + ph, ['#b6f06a', '#5cc234', '#2f7a1a']));
    }
    for (const hw of L.huge) {
        const fx = px + pw - pw * (hw / L.waves) + 6;
        const up = game.wave >= hw ? -6 : 0;
        c.beginPath(); c.moveTo(fx, py + ph); c.lineTo(fx, py - 16 + up); c.lineWidth = 2.5; c.strokeStyle = '#3a2410'; c.stroke();
        c.beginPath(); c.moveTo(fx, py - 16 + up); c.lineTo(fx + 15, py - 11 + up); c.lineTo(fx, py - 5 + up); c.closePath(); fs(c, '#e53935', '#5a0000', 1.2);
    }
    // 进度僵尸头
    const hx = px + pw - pw * prog;
    c.save(); c.translate(hx, py + ph / 2); c.scale(0.5, 0.5);
    drawZHead(c, ZBASE, { armor: 0, maxArmor: 1, t: 0 }, 0.3);
    c.restore();
    c.font = `15px ${FONT}`; c.textAlign = 'center'; c.fillStyle = '#fff4dc';
    c.lineWidth = 4; c.strokeStyle = 'rgba(40,20,0,.75)';
    const wt = game.wave === 0 ? '僵尸即将到来…' : `第 ${game.wave} / ${L.waves} 波`;
    c.strokeText(wt, px + pw / 2, py + ph + 18); c.fillText(wt, px + pw / 2, py + ph + 18);

    // 卡片提示
    if (hoverIdx >= 0 && !game.holding) {
        const s = game.seeds[hoverIdx], T = PT[s.type], R = packetRect(hoverIdx);
        const txt = `${T.name} · ${T.desc}`;
        c.font = `16px ${FONT}`;
        const tw = c.measureText(txt).width + 24;
        const tx = clamp(R.x + R.w / 2 - tw / 2, 6, W - tw - 6), ty = R.y + R.h + 12;
        rrect(c, tx, ty, tw, 28, 8); fs(c, 'rgba(255,248,225,.96)', '#5a3a14', 1.6);
        c.fillStyle = '#3a2004'; c.textAlign = 'left'; c.textBaseline = 'middle';
        c.fillText(txt, tx + 12, ty + 14.5);
        if (s.cd > 0 || game.sun < T.cost) {
            const w2 = s.cd > 0 ? '冷却中…' : '阳光不足';
            c.fillStyle = '#c62828'; c.font = `14px ${FONT}`;
            c.fillText(w2, tx + 12, ty + 42);
        }
    }

    if (game.trophy && game.state === 'play') {
        const tx = game.trophy.x, ty = game.trophy.y + 70;
        c.font = `20px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.lineWidth = 5; c.strokeStyle = 'rgba(60,30,0,.8)'; c.strokeText('点击领取奖杯！', tx, ty);
        c.fillStyle = '#fff4b0'; c.fillText('点击领取奖杯！', tx, ty);
    }
}

function renderBanners(c) {
    for (const b of game.banners) {
        if (b.t < 0) continue;
        const k = b.t / b.dur;
        const s = b.t < 0.25 ? easeOutBack(b.t / 0.25) : 1;
        const a = k > 0.8 ? (1 - k) / 0.2 : 1;
        c.save();
        c.globalAlpha = a;
        c.translate(W / 2, H / 2 + 20);
        c.scale(s, s);
        c.font = `${b.size}px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.lineJoin = 'round';
        c.lineWidth = b.size * 0.22; c.strokeStyle = 'rgba(0,0,0,.35)'; c.strokeText(b.text, 0, 6);
        c.lineWidth = b.size * 0.16; c.strokeStyle = '#2a0a00'; c.strokeText(b.text, 0, 0);
        c.fillStyle = b.color; c.fillText(b.text, 0, 0);
        c.restore();
    }
}

function renderCursor(c, cell) {
    if (!mouse.inside || game.state !== 'play' || !game.holding) return;
    if (game.holding.kind === 'seed') {
        const type = game.seeds[game.holding.idx].type;
        if (cell && !plantAt(cell.r, cell.col)) {
            const ghost = Object.assign(portraitOf(type), { x: colCenter(cell.col), y: rowBase(cell.r), r: cell.r, col: cell.col, t: realT });
            renderPlant(c, ghost, 0.42);
        }
        const p = Object.assign(portraitOf(type), { x: mouse.x, y: mouse.y + 40, t: realT });
        renderPlant(c, p, 0.9);
    } else {
        if (cell) {
            const p = plantAt(cell.r, cell.col);
            if (p) {
                c.save(); c.translate(p.x, p.y); c.globalCompositeOperation = 'lighter'; c.globalAlpha = 0.35;
                DRAW_PLANT[p.type](c, p); c.restore();
            }
        }
        drawShovel(c, mouse.x + 6, mouse.y - 4, 1.1, 0.5);
    }
}

// ======================================================================
// 输入
// ======================================================================
function inRect(p, R) { return p.x >= R.x && p.x <= R.x + R.w && p.y >= R.y && p.y <= R.y + R.h; }
function hoverCell() {
    if (!mouse.inside) return null;
    const col = Math.floor((mouse.x - G.x) / G.cw), r = Math.floor((mouse.y - G.y) / G.ch);
    if (col < 0 || col >= G.cols || r < 0 || r >= G.rows) return null;
    return { r, col };
}
function toLogical(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width * W, y: (e.clientY - rect.top) / rect.height * H };
}

function selectSeed(i) {
    if (game.state !== 'play') return;
    const s = game.seeds[i];
    if (!s) return;
    if (game.holding && game.holding.kind === 'seed' && game.holding.idx === i) { game.holding = null; return; }
    if (s.cd > 0 || game.sun < PT[s.type].cost) { SFX.deny(); return; }
    game.holding = { kind: 'seed', idx: i };
    SFX.pick();
}

function toggleShovel() {
    if (game.state !== 'play') return;
    game.holding = game.holding && game.holding.kind === 'shovel' ? null : { kind: 'shovel' };
    SFX.pick();
}

function onDown(e) {
    SFX.init();
    const m = toLogical(e);
    Object.assign(mouse, m, { inside: true });
    if (e.button === 2) { game.holding = null; return; }
    if (game.state === 'menu') return;

    // 按钮
    for (const b of BTNS) {
        if (Math.hypot(m.x - b.x, m.y - b.y) < b.r + 4) {
            if (b.id === 'pause') togglePause();
            if (b.id === 'speed') { game.speed = game.speed === 1 ? 2 : 1; SFX.pick(); }
            if (b.id === 'sound') { SFX.muted = !SFX.muted; SFX.pick(); }
            return;
        }
    }
    if (game.state !== 'play') return;

    // 奖杯
    if (game.trophy && Math.hypot(m.x - game.trophy.x, m.y - game.trophy.y) < 60) { claimTrophy(); return; }
    // 阳光（优先）
    for (let i = game.suns.length - 1; i >= 0; i--) {
        const s = game.suns[i];
        if (s.mode !== 'collect' && Math.hypot(m.x - s.x, m.y - s.y) < 42) { collectSun(s); return; }
    }
    // 卡片
    for (let i = 0; i < game.seeds.length; i++) if (inRect(m, packetRect(i))) { selectSeed(i); return; }
    if (inRect(m, shovelRect())) { toggleShovel(); return; }

    // 草坪
    const cell = hoverCell();
    if (cell && game.holding) {
        if (game.holding.kind === 'seed') {
            const s = game.seeds[game.holding.idx], T = PT[s.type];
            if (plantAt(cell.r, cell.col)) { SFX.deny(); return; }
            if (game.sun < T.cost || s.cd > 0) { SFX.deny(); game.holding = null; return; }
            game.sun -= T.cost; s.cd = T.cd;
            const p = makePlant(s.type, cell.r, cell.col);
            game.grid[cell.r][cell.col] = p;
            game.plants.push(p);
            dirt(p.x, p.y, 10);
            SFX.plant();
            game.holding = null;
        } else {
            const p = plantAt(cell.r, cell.col);
            if (p) { removePlant(p); dirt(p.x, p.y, 8); SFX.shovel(); }
            game.holding = null;
        }
    } else if (game.holding && !cell) {
        game.holding = null;
    }
}

canvas.addEventListener('pointerdown', onDown);
canvas.addEventListener('pointermove', e => {
    Object.assign(mouse, toLogical(e), { inside: true });
    let pointer = false;
    if (game.state === 'play') {
        pointer = game.seeds.some((_, i) => inRect(mouse, packetRect(i))) || inRect(mouse, shovelRect())
            || game.suns.some(s => Math.hypot(mouse.x - s.x, mouse.y - s.y) < 42)
            || (game.trophy && Math.hypot(mouse.x - game.trophy.x, mouse.y - game.trophy.y) < 60);
    }
    if (game.state !== 'menu') pointer = pointer || BTNS.some(b => Math.hypot(mouse.x - b.x, mouse.y - b.y) < b.r);
    canvas.style.cursor = game.holding && game.state === 'play' ? 'none' : (pointer ? 'pointer' : 'default');
});
canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') mouse.inside = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());

window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        if (game.holding) game.holding = null;
        else if (game.state === 'play' || game.state === 'paused') togglePause();
        return;
    }
    if (e.key === ' ' || e.key === 'p' || e.key === 'P') {
        if (game.state === 'play' || game.state === 'paused') { e.preventDefault(); togglePause(); }
        return;
    }
    if (e.key === 'q' || e.key === 'Q') { toggleShovel(); return; }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 9) selectSeed(n - 1);
});

function togglePause() {
    if (game.state === 'play') { game.state = 'paused'; showOverlay('pause'); }
    else if (game.state === 'paused') { game.state = 'play'; showOverlay(null); }
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.state === 'play') togglePause();
});

// ======================================================================
// 覆盖层 / 菜单
// ======================================================================
function showOverlay(id) {
    for (const o of document.querySelectorAll('.overlay')) o.classList.toggle('show', o.id === id);
}

document.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => {
    SFX.init();
    const act = btn.dataset.act;
    if (act === 'resume') togglePause();
    if (act === 'restart') startLevel(game.levelIdx);
    if (act === 'next') startLevel(Math.min(LEVELS.length - 1, game.levelIdx + 1));
    if (act === 'menu') { game.state = 'menu'; game.holding = null; buildLevelCards(); showOverlay('menu'); }
}));

function iconCanvas(drawFn, w, h) {
    const cv = document.createElement('canvas');
    const k = 2;
    cv.width = w * k; cv.height = h * k;
    const c = cv.getContext('2d');
    c.scale(k, k);
    drawFn(c);
    return cv;
}

function buildLevelCards() {
    const wrap = document.getElementById('levels');
    wrap.innerHTML = '';
    const done = loadDone();
    LEVELS.forEach((L, i) => {
        const el = document.createElement('button');
        el.className = 'lv';
        el.innerHTML = `<div class="num">1-${i + 1}</div><div class="name">${L.name}</div><div class="icons"></div><div class="new">${L.note}</div>${done.includes(i) ? '<div class="done">★</div>' : ''}`;
        const icons = el.querySelector('.icons');
        icons.appendChild(iconCanvas(c => {
            c.translate(40, 92);
            c.scale(0.85, 0.85);
            const p = portraitOf(L.featP);
            if (L.featP === 'chomper') c.translate(-10, 0);
            DRAW_PLANT[L.featP](c, p);
        }, 80, 100));
        icons.appendChild(iconCanvas(c => {
            c.translate(52, 112);
            c.scale(0.5, 0.5);
            const z = makeZombie(L.featZ, 0, 0);
            z.ph = 0.6; z.t = 0.4;
            drawZombie(c, z);
        }, 70, 116));
        el.addEventListener('click', () => startLevel(i));
        wrap.appendChild(el);
    });
}

function setupDemo() {
    const put = (type, r, col) => {
        const p = makePlant(type, r, col);
        p.pop = 0; p.armed = true; p.armK = 1;
        if (type.includes('shooter') || type === 'snowpea' || type === 'repeater') { p.shooter = true; p.timer = rand(0, 1.5); }
        return p;
    };
    demo.plants = [
        put('sunflower', 0, 0), put('peashooter', 0, 1), put('sunflower', 1, 0), put('repeater', 1, 1), put('wallnut', 1, 3),
        put('sunflower', 2, 0), put('snowpea', 2, 2), put('chomper', 3, 1), put('sunflower', 4, 0), put('peashooter', 4, 2), put('potatomine', 3, 4),
    ];
    demo.zombies = [
        Object.assign(makeZombie('normal', 0, 1000), {}),
        Object.assign(makeZombie('cone', 2, 860), {}),
        Object.assign(makeZombie('bucket', 3, 1060), {}),
        Object.assign(makeZombie('flag', 1, 1110), {}),
        Object.assign(makeZombie('football', 4, 940), {}),
    ];
}

// ======================================================================
// 主循环
// ======================================================================
let lastT = performance.now();
function frame(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
}

let rzTimer = null;
window.addEventListener('resize', () => { clearTimeout(rzTimer); rzTimer = setTimeout(resize, 120); });
document.getElementById('rotate').addEventListener('click', e => { e.currentTarget.dataset.off = '1'; e.currentTarget.classList.remove('on'); });

setupDemo();
resize();
buildLevelCards();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => buildLevelCards());
requestAnimationFrame(frame);

// 调试接口（便于测试）
window.__pvz = { game, startLevel, spawnWave, makeZombie, makePlant, PT, LEVELS };
})();
