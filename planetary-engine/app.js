import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* =========================================================
   常量
   ========================================================= */
const R = 10;                         // 地球半径（场景单位）
const TOWER_H = 0.24;                 // 发动机塔高度（为可见性放大）
const JET_MAX = 6.8;                  // 满功率等离子束长度
const BRAKE_TILT = THREE.MathUtils.degToRad(55);
const GM = 4 * Math.PI * Math.PI;     // 太阳引力常数 AU³/yr²
const GM_J = GM / 1047.6;             // 木星
const J_A = 5.203, J_T = 11.862;      // 木星轨道半径 / 周期
const AU_YR_TO_KMS = 4.7406;
const PUSH_ACC = 1.35;                // 满推力加速度 AU/yr²（为可玩性大幅放大）
const BRAKE_DAYS = 220;               // 满推力制动自转所需天数
const isSmall = Math.min(innerWidth, innerHeight) < 700 || matchMedia('(pointer: coarse)').matches;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);

/* =========================================================
   噪声
   ========================================================= */
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const perm = new Uint8Array(512);
{
    const rnd = mulberry32(20791);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
}
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
function grad(h, x, y, z) {
    h &= 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}
function noise3(x, y, z) {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const X = fx & 255, Y = fy & 255, Z = fz & 255;
    x -= fx; y -= fy; z -= fz;
    const u = fade(x), v = fade(y), w = fade(z);
    const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;
    return lerp(
        lerp(lerp(grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z), u),
            lerp(grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z), u), v),
        lerp(lerp(grad(perm[AA + 1], x, y, z - 1), grad(perm[BA + 1], x - 1, y, z - 1), u),
            lerp(grad(perm[AB + 1], x, y - 1, z - 1), grad(perm[BB + 1], x - 1, y - 1, z - 1), u), v),
        w);
}
function fbm(x, y, z, oct) {
    let s = 0, a = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { s += a * noise3(x * f, y * f, z * f); f *= 2.03; a *= 0.5; }
    return s;
}
function ridged(x, y, z, oct) {
    let s = 0, a = 0.5, f = 1;
    for (let i = 0; i < oct; i++) {
        const n = 1 - Math.abs(noise3(x * f, y * f, z * f));
        s += a * n * n; f *= 2.1; a *= 0.5;
    }
    return s;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/* 与 THREE.SphereGeometry 一致的 uv → 球面映射 */
function uvToDir(u, v, out) {
    const phi = u * Math.PI * 2, theta = v * Math.PI;
    out.x = -Math.cos(phi) * Math.sin(theta);
    out.y = Math.cos(theta);
    out.z = Math.sin(phi) * Math.sin(theta);
    return out;
}
function dirToUv(d) {
    let phi = Math.atan2(d.z, -d.x);
    if (phi < 0) phi += Math.PI * 2;
    return [phi / (Math.PI * 2), Math.acos(THREE.MathUtils.clamp(d.y, -1, 1)) / Math.PI];
}
const OFF = [3.7, -1.3, 8.1];
const landHeight = (x, y, z) => fbm(x * 1.55 + OFF[0], y * 1.55 + OFF[1], z * 1.55 + OFF[2], 6) + 0.035;

/* =========================================================
   地表纹理（冰封地球）
   ========================================================= */
async function buildTextures(onProgress) {
    const W = isSmall ? 1024 : 2048, H = W / 2;
    const day = document.createElement('canvas'); day.width = W; day.height = H;
    const mask = document.createElement('canvas'); mask.width = W; mask.height = H;
    const cloud = document.createElement('canvas'); cloud.width = W / 2; cloud.height = H / 2;
    const dctx = day.getContext('2d'), mctx = mask.getContext('2d'), cctx = cloud.getContext('2d');
    const dImg = dctx.createImageData(W, H), mImg = mctx.createImageData(W, H);
    const dd = dImg.data, md = mImg.data;
    const p = new THREE.Vector3();
    const t0 = performance.now();
    let last = t0;

    for (let y = 0; y < H; y++) {
        const v = (y + 0.5) / H;
        for (let x = 0; x < W; x++) {
            uvToDir((x + 0.5) / W, v, p);
            const h = landHeight(p.x, p.y, p.z);
            const det = fbm(p.x * 9 + 11, p.y * 9, p.z * 9, 3);
            const lat = Math.abs(p.y);
            let r, g, b, spec;
            if (h > 0) {
                const m = ridged(p.x * 3.4 + 5, p.y * 3.4, p.z * 3.4, 4);
                const snow = smooth(0.2, 0.75, 0.55 + det * 1.6 - m * 0.55 + lat * 0.35 + h * 0.6);
                const rock = 0.55 + det * 0.6;
                r = lerp(44 * rock, 190, snow);
                g = lerp(46 * rock, 198, snow);
                b = lerp(52 * rock, 212, snow);
                const coast = smooth(0.035, 0, h);
                r = lerp(r, 120, coast * 0.5); g = lerp(g, 132, coast * 0.5); b = lerp(b, 148, coast * 0.5);
                spec = 0.12 + snow * 0.25;
            } else {
                const depth = smooth(0, -0.35, h);
                const crack = Math.pow(1 - Math.abs(noise3(p.x * 16, p.y * 16, p.z * 16)), 22)
                    + 0.6 * Math.pow(1 - Math.abs(noise3(p.x * 41 + 3, p.y * 41, p.z * 41)), 30);
                const floe = det * 0.5 + 0.5;
                r = lerp(122, 70, depth) * (0.9 + floe * 0.2);
                g = lerp(148, 96, depth) * (0.9 + floe * 0.2);
                b = lerp(172, 132, depth) * (0.9 + floe * 0.2);
                const pole = smooth(0.55, 0.95, lat);
                r = lerp(r, 200, pole); g = lerp(g, 210, pole); b = lerp(b, 224, pole);
                const c = Math.min(1, crack) * (1 - pole);
                r = lerp(r, 48, c * 0.7); g = lerp(g, 66, c * 0.7); b = lerp(b, 88, c * 0.7);
                spec = 0.75 - c * 0.5;
            }
            const i = (y * W + x) * 4;
            dd[i] = r; dd[i + 1] = g; dd[i + 2] = b; dd[i + 3] = 255;
            md[i] = spec * 255; md[i + 1] = h > 0 ? 255 : 0; md[i + 2] = 0; md[i + 3] = 255;
        }
        const now = performance.now();
        if (now - last > 30) {
            onProgress(y / H * 0.8);
            last = now;
            await new Promise(requestAnimationFrame);
        }
    }
    dctx.putImageData(dImg, 0, 0);
    mctx.putImageData(mImg, 0, 0);

    // 云层（稀薄）
    const CW = cloud.width, CH = cloud.height;
    const cImg = cctx.createImageData(CW, CH), cd = cImg.data;
    for (let y = 0; y < CH; y++) {
        const v = (y + 0.5) / CH;
        for (let x = 0; x < CW; x++) {
            uvToDir((x + 0.5) / CW, v, p);
            const n = fbm(p.x * 2.4 + 40, p.y * 5.5, p.z * 2.4, 5);
            const a = smooth(0.08, 0.42, n);
            const i = (y * CW + x) * 4;
            cd[i] = cd[i + 1] = cd[i + 2] = 255; cd[i + 3] = a * 200;
        }
        if (y % 32 === 0) { onProgress(0.8 + y / CH * 0.12); await new Promise(requestAnimationFrame); }
    }
    cctx.putImageData(cImg, 0, 0);

    const mk = (c, srgb) => {
        const t = new THREE.CanvasTexture(c);
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        t.wrapS = THREE.RepeatWrapping;
        return t;
    };
    return { day: mk(day, true), mask: mk(mask, false), cloud: mk(cloud, true), W, H };
}

/* 夜面灯光 + 发动机辉光贴图 */
function buildLightMaps(engines, W, H) {
    const night = document.createElement('canvas'); night.width = W; night.height = H;
    const glow = document.createElement('canvas'); glow.width = W / 2; glow.height = H / 2;
    const n = night.getContext('2d'), g = glow.getContext('2d');
    n.fillStyle = '#000'; n.fillRect(0, 0, W, H);
    g.fillStyle = '#000'; g.fillRect(0, 0, glow.width, glow.height);
    const rnd = mulberry32(77);
    const p = new THREE.Vector3();

    const dot = (ctx, cw, ch, d, rad, color, alpha) => {
        const [u, v] = dirToUv(d);
        const stretch = 1 / Math.max(0.25, Math.sqrt(1 - d.y * d.y));
        for (const off of [-1, 0, 1]) {
            const x = (u + off) * cw, y = v * ch;
            if (x < -rad * stretch * 2 || x > cw + rad * stretch * 2) continue;
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(stretch, 1);
            const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, rad);
            gr.addColorStop(0, color.replace('A', alpha));
            gr.addColorStop(1, color.replace('A', 0));
            ctx.fillStyle = gr;
            ctx.fillRect(-rad, -rad, rad * 2, rad * 2);
            ctx.restore();
        }
    };

    // 地下城入口的稀疏灯光：聚集在发动机附近
    n.globalCompositeOperation = 'lighter';
    for (const e of engines) {
        const count = 10 + Math.floor(rnd() * 14);
        for (let k = 0; k < count; k++) {
            p.copy(e.n).add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.16)).normalize();
            dot(n, W, H, p, (1 + rnd() * 2.2) * (W / 2048), 'rgba(255,178,92,A)', 0.5 + rnd() * 0.4);
        }
    }
    // 交通线（发动机之间连接）
    n.strokeStyle = 'rgba(255,160,80,0.08)';
    n.lineWidth = 1;
    for (let i = 0; i < engines.length; i++) {
        const a = engines[i], b = engines[(i * 7 + 3) % engines.length];
        if (a.n.angleTo(b.n) > 0.35) continue;
        for (let s = 0; s <= 24; s++) {
            p.copy(a.n).lerp(b.n, s / 24).normalize();
            dot(n, W, H, p, 1.4, 'rgba(255,170,90,A)', 0.18);
        }
    }

    g.globalCompositeOperation = 'lighter';
    for (const e of engines) dot(g, glow.width, glow.height, e.n, 20 * (glow.width / 1024), 'rgba(255,255,255,A)', 0.24);

    const mk = (c) => {
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = THREE.RepeatWrapping;
        return t;
    };
    return { night: mk(night), glow: mk(glow) };
}

/* =========================================================
   场景
   ========================================================= */
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, isSmall ? 1.75 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x010207);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.03, 6000);
const ORBIT_DIST = innerWidth < innerHeight ? 78 : 44;
camera.position.set(14, 9, 40).setLength(ORBIT_DIST);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 13;
controls.maxDistance = 140;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.7;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.9, 0.55, 0.8);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const sunLight = new THREE.DirectionalLight(0xfff2e0, 2.2);
scene.add(sunLight, sunLight.target);
scene.add(new THREE.AmbientLight(0x2a3a5a, 0.35));

const uni = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uSun: { value: 1 },
    uPower: { value: 0 },
};

/* ---------- 星空 ---------- */
function buildStars() {
    const N = isSmall ? 4500 : 9000;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), ph = new Float32Array(N);
    const rnd = mulberry32(9);
    const v = new THREE.Vector3();
    const band = new THREE.Vector3(0.3, 1, 0.2).normalize(); // 银河法线
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
        v.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
        if (i < N * 0.45) {
            // 银河带：压向一个大圆
            const d = v.dot(band);
            v.addScaledVector(band, -d * (0.85 + rnd() * 0.15)).normalize();
        }
        v.multiplyScalar(1500);
        pos.set([v.x, v.y, v.z], i * 3);
        const t = rnd();
        c.setHSL(t < 0.7 ? 0.6 : (t < 0.9 ? 0.1 : 0.0), t < 0.7 ? 0.35 : 0.6, 0.75 + rnd() * 0.25);
        col.set([c.r, c.g, c.b], i * 3);
        size[i] = Math.pow(rnd(), 6) * 3.4 + 0.7;
        ph[i] = rnd() * 10;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: uni.uTime, uPR: { value: renderer.getPixelRatio() } },
        vertexShader: /* glsl */`
            attribute vec3 aColor; attribute float aSize; attribute float aPhase;
            uniform float uTime; uniform float uPR;
            varying vec3 vColor; varying float vTw;
            void main(){
                vColor = aColor;
                vTw = 0.7 + 0.3 * sin(uTime * (0.6 + fract(aPhase) * 1.8) + aPhase * 7.0);
                gl_PointSize = aSize * uPR;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: /* glsl */`
            varying vec3 vColor; varying float vTw;
            void main(){
                float d = length(gl_PointCoord - 0.5);
                float a = smoothstep(0.5, 0.0, d);
                gl_FragColor = vec4(vColor * vTw * 0.9, a * a);
            }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    return pts;
}
const stars = buildStars();
scene.add(stars);

/* ---------- 太阳 ---------- */
function radialTexture(stops, size = 256) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [o, col] of stops) gr.addColorStop(o, col);
    g.fillStyle = gr; g.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
const sunCore = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture([[0, '#ffffff'], [0.18, '#fff6e0'], [0.32, 'rgba(255,214,150,0.9)'], [0.55, 'rgba(255,170,90,0.22)'], [1, 'rgba(255,140,60,0)']]),
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
}));
const sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture([[0, 'rgba(255,220,170,0.35)'], [0.3, 'rgba(255,170,100,0.08)'], [1, 'rgba(255,140,60,0)']]),
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
}));
sunCore.material.color.setScalar(2.2);
scene.add(sunCore, sunHalo);

/* ---------- 地球 ---------- */
const tiltGroup = new THREE.Group();
tiltGroup.rotation.z = THREE.MathUtils.degToRad(23.44);
scene.add(tiltGroup);
const earth = new THREE.Group();
tiltGroup.add(earth);

const GLSL_NOISE = /* glsl */`
    float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float vnoise(vec3 x){
        vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
    }`;

let earthMat, cloudMat;
function buildEarth(tex, maps) {
    earthMat = new THREE.ShaderMaterial({
        uniforms: {
            ...uni,
            uDay: { value: tex.day }, uMask: { value: tex.mask },
            uNight: { value: maps.night }, uGlow: { value: maps.glow },
        },
        vertexShader: /* glsl */`
            varying vec2 vUv; varying vec3 vNw; varying vec3 vPw; varying vec3 vPo;
            void main(){
                vUv = uv; vPo = position;
                vec4 wp = modelMatrix * vec4(position, 1.0);
                vPw = wp.xyz;
                vNw = normalize(mat3(modelMatrix) * normal);
                gl_Position = projectionMatrix * viewMatrix * wp;
            }`,
        fragmentShader: /* glsl */`
            uniform sampler2D uDay, uMask, uNight, uGlow;
            uniform vec3 uSunDir; uniform float uSun, uPower, uTime;
            varying vec2 vUv; varying vec3 vNw; varying vec3 vPw; varying vec3 vPo;
            ${GLSL_NOISE}
            void main(){
                vec3 N = normalize(vNw);
                vec3 V = normalize(cameraPosition - vPw);
                vec3 L = normalize(uSunDir);
                float ndl = dot(N, L);
                float day = smoothstep(-0.08, 0.3, ndl);

                vec3 albedo = texture2D(uDay, vUv).rgb;
                float detail = vnoise(vPo * 6.0) * 0.6 + vnoise(vPo * 23.0) * 0.4;
                albedo *= 0.88 + detail * 0.24;
                vec3 m = texture2D(uMask, vUv).rgb;

                vec3 H = normalize(L + V);
                float spec = pow(max(dot(N, H), 0.0), 70.0) * m.r * day;

                vec3 col = albedo * (0.004 + max(ndl, 0.0) * uSun * 0.95);
                col += vec3(1.0, 0.95, 0.88) * spec * uSun * 0.6;

                // 夜面灯光
                vec3 lights = texture2D(uNight, vUv).rgb;
                col += lights * (1.0 - day) * 1.6;

                // 发动机照亮冰原
                float glow = texture2D(uGlow, vUv).r;
                float flick = 0.92 + 0.08 * sin(uTime * 13.0 + vPo.x * 3.0);
                float night = 1.0 - day;
                col += vec3(0.22, 0.45, 1.0) * glow * glow * uPower * 1.1 * flick * (0.12 + 0.88 * night);
                col += albedo * vec3(0.3, 0.5, 1.0) * glow * uPower * 0.35 * night;

                // 大气散射边缘
                float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
                vec3 atm = mix(vec3(0.25, 0.42, 0.95), vec3(0.5, 0.45, 1.0), uPower);
                col += atm * fres * (0.04 + 0.45 * smoothstep(-0.25, 0.5, ndl) * uSun + uPower * 0.22);

                gl_FragColor = vec4(col, 1.0);
            }`,
    });
    const seg = isSmall ? 96 : 160;
    const globe = new THREE.Mesh(new THREE.SphereGeometry(R, seg, seg / 2), earthMat);
    earth.add(globe);

    cloudMat = new THREE.ShaderMaterial({
        uniforms: { ...uni, uCloud: { value: tex.cloud }, uGlow: { value: maps.glow }, uOff: { value: 0 } },
        vertexShader: /* glsl */`
            varying vec2 vUv; varying vec3 vNw;
            void main(){
                vUv = uv; vNw = normalize(mat3(modelMatrix) * normal);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: /* glsl */`
            uniform sampler2D uCloud, uGlow; uniform vec3 uSunDir; uniform float uSun, uPower, uOff;
            varying vec2 vUv; varying vec3 vNw;
            void main(){
                float a = texture2D(uCloud, vUv + vec2(uOff, 0.0)).a;
                float ndl = dot(normalize(vNw), normalize(uSunDir));
                float g = texture2D(uGlow, vUv).r;
                vec3 col = vec3(0.92, 0.95, 1.0) * (0.004 + max(ndl, 0.0) * uSun * 1.1) + vec3(0.35, 0.55, 1.0) * g * uPower * 0.9;
                gl_FragColor = vec4(col, a * 0.38);
            }`,
        transparent: true, depthWrite: false,
    });
    const clouds = new THREE.Mesh(new THREE.SphereGeometry(R * 1.012, seg, seg / 2), cloudMat);
    earth.add(clouds);
}

/* 大气光晕 */
const atmoMat = new THREE.ShaderMaterial({
    uniforms: uni,
    vertexShader: /* glsl */`
        varying vec3 vNw; varying vec3 vPw;
        void main(){
            vNw = normalize(mat3(modelMatrix) * normal);
            vec4 wp = modelMatrix * vec4(position, 1.0); vPw = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
    fragmentShader: /* glsl */`
        uniform vec3 uSunDir; uniform float uSun, uPower;
        varying vec3 vNw; varying vec3 vPw;
        void main(){
            vec3 V = normalize(cameraPosition - vPw);
            vec3 N = normalize(vNw);
            float k = clamp(-dot(N, V), 0.0, 1.0);
            float rim = pow(k, 5.0);
            float lit = smoothstep(-0.45, 0.6, dot(N, normalize(uSunDir)));
            vec3 c = vec3(0.3, 0.55, 1.0) * lit * uSun * 1.3 + vec3(0.45, 0.4, 1.0) * uPower * 0.75 + vec3(0.1, 0.18, 0.4) * 0.12;
            gl_FragColor = vec4(c * rim, rim);
        }`,
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(R * 1.13, 96, 48), atmoMat);
scene.add(atmosphere);

/* =========================================================
   发动机
   ========================================================= */
const engines = [];
function placeEngines() {
    const N = 1300;
    const rnd = mulberry32(4242);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const cand = [];
    for (let i = 0; i < N; i++) {
        const y = 1 - (i + 0.5) / N * 2;
        const r = Math.sqrt(1 - y * y);
        const th = golden * i;
        const n = new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r);
        n.x += (rnd() - 0.5) * 0.02; n.z += (rnd() - 0.5) * 0.02; n.normalize();
        if (Math.abs(n.y) > 0.86) continue;
        const h = landHeight(n.x, n.y, n.z);
        if (h > 0.03) cand.push({ n, h });
    }
    // 打乱后取前 MAX 个
    for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
    const MAX = isSmall ? 144 : 192;
    const up = new THREE.Vector3(0, 1, 0);
    for (const c of cand.slice(0, MAX)) {
        const n = c.n;
        const e = new THREE.Vector3().crossVectors(up, n).normalize();
        engines.push({
            n, e,
            p: n.clone().multiplyScalar(R),
            power: 0, startAt: Infinity, stopAt: Infinity,
            seed: rnd(), fault: 0, yaw: rnd() * Math.PI * 2,
        });
    }
}

let jetCore, jetOuter, towers, rings, pools, flares, powerAttr;
function buildEngineMeshes() {
    const count = engines.length;
    const dummy = new THREE.Object3D();
    const Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

    // 塔体（旋转体：底座 → 收腰 → 喷口）
    const prof = [
        [0.0, 0], [0.135, 0], [0.135, 0.018], [0.1, 0.03], [0.075, 0.09], [0.05, 0.16],
        [0.046, 0.19], [0.058, 0.215], [0.07, 0.24], [0.062, 0.24], [0.04, 0.2], [0, 0.2],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const towerGeo = new THREE.LatheGeometry(prof, 18);
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x8792a3, metalness: 0.65, roughness: 0.42, emissive: 0x0a1428 });
    towers = new THREE.InstancedMesh(towerGeo, towerMat, count);

    const ringGeo = new THREE.TorusGeometry(0.066, 0.008, 6, 24);
    ringGeo.rotateX(Math.PI / 2);
    ringGeo.translate(0, TOWER_H - 0.004, 0);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    rings = new THREE.InstancedMesh(ringGeo, ringMat, count);

    const q = new THREE.Quaternion(), qy = new THREE.Quaternion();
    for (let i = 0; i < count; i++) {
        const en = engines[i];
        q.setFromUnitVectors(Y, en.n);
        qy.setFromAxisAngle(Y, en.yaw);
        dummy.position.copy(en.p).addScaledVector(en.n, -0.01);
        dummy.quaternion.copy(q).multiply(qy);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        towers.setMatrixAt(i, dummy.matrix);
        rings.setMatrixAt(i, dummy.matrix);
        rings.setColorAt(i, new THREE.Color(0x1a2a44));
    }
    towers.instanceMatrix.needsUpdate = true;
    rings.instanceColor.needsUpdate = true;

    // 等离子束
    const jetGeo = new THREE.CylinderGeometry(1, 0.32, 1, 20, 40, true);
    jetGeo.translate(0, 0.5, 0);
    powerAttr = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    powerAttr.setUsage(THREE.DynamicDrawUsage);
    const seedAttr = new THREE.InstancedBufferAttribute(Float32Array.from(engines.map((e) => e.seed)), 1);
    jetGeo.setAttribute('aPower', powerAttr);
    jetGeo.setAttribute('aSeed', seedAttr);

    const jetVS = /* glsl */`
        attribute float aPower; attribute float aSeed;
        varying float vY; varying float vPower; varying float vSeed; varying vec3 vN; varying vec3 vV;
        void main(){
            vY = position.y; vPower = aPower; vSeed = aSeed;
            vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
            vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
            vV = -mv.xyz;
            gl_Position = projectionMatrix * mv;
        }`;
    const jetFS = (core) => /* glsl */`
        uniform float uTime;
        varying float vY; varying float vPower; varying float vSeed; varying vec3 vN; varying vec3 vV;
        void main(){
            if (vPower < 0.002) discard;
            float y = vY;
            float edge = pow(abs(dot(normalize(vN), normalize(vV))), ${core ? '1.2' : '2.2'});
            float fall = pow(1.0 - y, ${core ? '2.2' : '1.4'});
            float base = exp(-y * ${core ? '9.0' : '5.0'});
            float t = uTime * 1.0;
            float turb = 0.72 + 0.28 * sin(y * 34.0 - t * 38.0 + vSeed * 40.0) * sin(y * 11.0 - t * 17.0 + vSeed * 9.0);
            float diamonds = pow(0.5 + 0.5 * cos(y * 120.0), 6.0) * exp(-y * 14.0);
            float flick = 0.88 + 0.12 * sin(t * 47.0 + vSeed * 80.0);
            vec3 cA = ${core ? 'vec3(0.62, 0.82, 1.0)' : 'vec3(0.2, 0.45, 1.0)'};
            vec3 cB = ${core ? 'vec3(0.3, 0.52, 1.0)' : 'vec3(0.42, 0.28, 1.0)'};
            vec3 col = mix(cA, cB, smoothstep(0.0, 0.7, y));
            float I = (fall * turb + base * 1.6 + diamonds * ${core ? '2.5' : '0.6'}) * edge * flick * vPower;
            gl_FragColor = vec4(col * I * ${core ? '1.7' : '0.75'}, clamp(I, 0.0, 1.0));
        }`;
    const mkJetMat = (core) => new THREE.ShaderMaterial({
        uniforms: { uTime: uni.uTime },
        vertexShader: jetVS, fragmentShader: jetFS(core),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    jetCore = new THREE.InstancedMesh(jetGeo, mkJetMat(true), count);
    jetOuter = new THREE.InstancedMesh(jetGeo, mkJetMat(false), count);
    for (const m of [jetCore, jetOuter]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; }

    // 地面光池
    const poolGeo = new THREE.PlaneGeometry(1, 1);
    poolGeo.setAttribute('aPower', powerAttr);
    const poolMat = new THREE.ShaderMaterial({
        vertexShader: /* glsl */`
            attribute float aPower; varying vec2 vUv; varying float vPower;
            void main(){ vUv = uv; vPower = aPower; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`
            varying vec2 vUv; varying float vPower;
            void main(){
                float d = length(vUv - 0.5) * 2.0;
                float a = pow(max(1.0 - d, 0.0), 2.6);
                gl_FragColor = vec4(vec3(0.3, 0.55, 1.0) * a * vPower * 1.1, a);
            }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        polygonOffset: true, polygonOffsetFactor: -4,
    });
    pools = new THREE.InstancedMesh(poolGeo, poolMat, count);
    for (let i = 0; i < count; i++) {
        const en = engines[i];
        q.setFromUnitVectors(Z, en.n);
        dummy.position.copy(en.p).addScaledVector(en.n, 0.012);
        dummy.quaternion.copy(q);
        dummy.scale.setScalar(1.25);
        dummy.updateMatrix();
        pools.setMatrixAt(i, dummy.matrix);
    }

    // 喷口闪光（点精灵）
    const fpos = new Float32Array(count * 3);
    engines.forEach((en, i) => { const v = en.p.clone().addScaledVector(en.n, TOWER_H + 0.02); fpos.set([v.x, v.y, v.z], i * 3); });
    const fGeo = new THREE.BufferGeometry();
    fGeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
    fGeo.setAttribute('aPower', powerAttr);
    const fMat = new THREE.ShaderMaterial({
        uniforms: { uPR: { value: renderer.getPixelRatio() }, uTime: uni.uTime },
        vertexShader: /* glsl */`
            attribute float aPower; uniform float uPR; varying float vPower;
            void main(){
                vPower = aPower;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = min(aPower * 34.0 * uPR * (12.0 / -mv.z), 220.0);
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: /* glsl */`
            varying float vPower;
            void main(){
                float d = length(gl_PointCoord - 0.5) * 2.0;
                float a = exp(-d * d * 5.0);
                gl_FragColor = vec4(vec3(0.55, 0.78, 1.0) * a * vPower * 1.6, a);
            }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    flares = new THREE.Points(fGeo, fMat);
    flares.frustumCulled = false;

    earth.add(towers, rings, pools, jetOuter, jetCore, flares);
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0), _col = new THREE.Color();
function updateEngineMeshes(time, thrust, tilt) {
    for (let i = 0; i < engines.length; i++) {
        const en = engines[i];
        let pw = en.power;
        if (en.fault > 0) pw *= 0.15 + 0.15 * Math.sin(time * 40 + i);
        // 点火初期的抖动
        const sinceStart = time - en.startAt;
        if (sinceStart > 0 && sinceStart < 1.2) pw *= 0.65 + 0.35 * Math.abs(Math.sin(time * 61 + i * 3.1));
        const out = pw * (0.18 + 0.82 * thrust);
        powerAttr.array[i] = out;

        const t = tilt * (0.9 + en.seed * 0.2);
        _d.copy(en.n).multiplyScalar(Math.cos(t)).addScaledVector(en.e, Math.sin(t)).normalize();
        _q.setFromUnitVectors(_Y, _d);
        _p.copy(en.p).addScaledVector(en.n, TOWER_H - 0.02);
        const len = Math.max(out, 0.0001) * JET_MAX * (0.9 + en.seed * 0.25);
        _s.set(0.055 + out * 0.02, len, 0.055 + out * 0.02);
        _m.compose(_p, _q, _s); jetCore.setMatrixAt(i, _m);
        _s.set(0.16 + out * 0.08, len * 0.82, 0.16 + out * 0.08);
        _m.compose(_p, _q, _s); jetOuter.setMatrixAt(i, _m);

        _col.setRGB(0.1 + out * 2.2, 0.16 + out * 3.4, 0.27 + out * 5.0);
        rings.setColorAt(i, _col);
    }
    powerAttr.needsUpdate = true;
    jetCore.instanceMatrix.needsUpdate = true;
    jetOuter.instanceMatrix.needsUpdate = true;
    rings.instanceColor.needsUpdate = true;
}

/* =========================================================
   模拟状态
   ========================================================= */
const sim = {
    running: false,       // 发动机是否处于点火状态
    arming: false,
    paused: false,
    thrustTarget: 0.8,
    thrust: 0.8,
    mode: 'brake',
    tilt: 0,
    daysPerSec: 15,
    days: 0,
    omega: 1,             // 自转角速度（相对初始）
    pos: new THREE.Vector2(1, 0),
    vel: new THREE.Vector2(0, 2 * Math.PI),
    trail: [],
    phase: 'idle',
    milestones: new Set(),
    spin: 0,
    jAngle0: THREE.MathUtils.degToRad(52),
};

function resetSim() {
    Object.assign(sim, { running: false, arming: false, days: 0, omega: 1, tilt: 0, phase: 'idle', spin: sim.spin });
    sim.pos.set(1, 0); sim.vel.set(0, 2 * Math.PI);
    sim.trail.length = 0;
    sim.milestones.clear();
    engines.forEach((e) => { e.power = 0; e.startAt = Infinity; e.stopAt = Infinity; e.fault = 0; });
    countdownAbort?.();
    updateIgniteButton();
    logEvent('模拟已重置 · 地球回到初始轨道', 'info');
}

function jupiterPos(days, out = new THREE.Vector2()) {
    const a = sim.jAngle0 + (days / 365.25) / J_T * Math.PI * 2;
    return out.set(Math.cos(a) * J_A, Math.sin(a) * J_A);
}

/* 总有效功率 0..1 */
function arrayPower() {
    let s = 0;
    for (const e of engines) s += e.fault > 0 ? e.power * 0.2 : e.power;
    return engines.length ? s / engines.length : 0;
}

const _acc = new THREE.Vector2(), _jp = new THREE.Vector2(), _rel = new THREE.Vector2();
function stepPhysics(dtDays) {
    const P = arrayPower() * sim.thrust;
    const brakeShare = Math.sin(sim.tilt) / Math.sin(BRAKE_TILT);
    const pushShare = Math.cos(sim.tilt);
    // 自转制动
    if (sim.omega > 0) sim.omega = Math.max(0, sim.omega - P * brakeShare * dtDays / BRAKE_DAYS);
    // 自转越快，径向推力被平均抵消得越多
    const eff = 1 - 0.85 * sim.omega;
    const acc = P * pushShare * eff * PUSH_ACC;

    let remaining = dtDays / 365.25;
    const H = 0.0015;
    while (remaining > 0) {
        const h = Math.min(H, remaining);
        remaining -= h;
        const r = sim.pos.length();
        _acc.copy(sim.pos).multiplyScalar(-GM / (r * r * r));
        jupiterPos(sim.days + (dtDays - remaining * 365.25), _jp);
        _rel.copy(_jp).sub(sim.pos);
        const rj = Math.max(_rel.length(), 0.02);
        _acc.addScaledVector(_rel, GM_J / (rj * rj * rj));
        if (acc > 0) _acc.addScaledVector(_d2.copy(sim.vel).normalize(), acc);
        sim.vel.addScaledVector(_acc, h);
        sim.pos.addScaledVector(sim.vel, h);
    }
    sim.days += dtDays;

    const last = sim.trail[sim.trail.length - 1];
    if (!last || last.distanceTo(sim.pos) > 0.012) {
        sim.trail.push(sim.pos.clone());
        if (sim.trail.length > 6000) sim.trail.shift();
    }
    return { P, eff };
}
const _d2 = new THREE.Vector2();

/* =========================================================
   UI
   ========================================================= */
const ui = {
    clock: $('clock'), dist: $('tDist'), vel: $('tVel'), esc: $('tEsc'), spinV: $('tSpin'), spinU: $('tSpinU'),
    temp: $('tTemp'), jup: $('tJup'), thrust: $('tThrust'), eff: $('tEff'),
    mBrake: $('mBrake'), mBrakeV: $('mBrakeV'), mEsc: $('mEsc'), mEscV: $('mEscV'),
    phase: $('phase'), phaseText: $('phaseText'), online: $('online'), total: $('total'),
    ignite: $('ignite'), igniteText: $('igniteText'), igniteSub: $('igniteSub'),
    log: $('log'), toast: $('toast'), grid: $('engineGrid'), orbitScale: $('orbitScale'),
};

function fmtDays(d) {
    const y = Math.floor(d / 365.25);
    const rem = Math.floor(d - y * 365.25);
    return y > 0 ? `T+ ${y} 年 ${rem} 天` : `T+ ${Math.floor(d)} 天`;
}

function logEvent(msg, level = '') {
    const li = document.createElement('li');
    if (level) li.className = level;
    li.innerHTML = `<time>${fmtDays(sim.days).replace('T+ ', '')}</time><span></span>`;
    li.lastChild.textContent = msg;
    ui.log.prepend(li);
    while (ui.log.children.length > 8) ui.log.lastChild.remove();
}

let toastTimer;
function toast(msg, level = '') {
    ui.toast.textContent = msg;
    ui.toast.className = `toast show ${level}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3200);
}

let gridCells = [];
function buildGrid() {
    ui.total.textContent = engines.length;
    const shown = Math.min(engines.length, 192);
    ui.grid.innerHTML = '<i></i>'.repeat(shown);
    gridCells = [...ui.grid.children];
}

function updateIgniteButton() {
    const b = ui.ignite;
    b.classList.toggle('running', sim.running);
    b.classList.toggle('arming', sim.arming);
    b.setAttribute('aria-pressed', String(sim.running));
    ui.igniteText.textContent = sim.arming ? '待命' : (sim.running ? '熄火' : '点火');
    ui.igniteSub.textContent = sim.arming ? 'ARMING' : (sim.running ? 'SHUTDOWN' : 'IGNITE');
}

function setSeg(group, value) {
    for (const b of $(group).children) b.setAttribute('aria-checked', String(b.dataset.v === String(value)));
}

/* ---------- 点火序列 ---------- */
const cdEl = $('countdown'), cdNum = $('cdNum'), cdMsg = $('cdMsg');
let countdownAbort = null;
const CD_STEPS = ['点火序列启动 · 全球同步', '聚变堆功率 · 爬升至额定', '等离子约束场 · 稳定', '喷口姿态 · 校准完成', '全部系统 · 就绪'];

function startIgnition() {
    if (sim.running || sim.arming) return;
    sim.arming = true;
    updateIgniteButton();
    cdEl.classList.add('show');
    let n = 5;
    let timer;
    const tick = () => {
        if (n === 0) {
            cdNum.textContent = '点火';
            cdMsg.textContent = 'IGNITION';
            cdNum.classList.remove('tick'); void cdNum.offsetWidth; cdNum.classList.add('tick');
            audio.blip(1320, 0.25);
            ignite();
            timer = setTimeout(() => cdEl.classList.remove('show'), 1100);
            return;
        }
        cdNum.textContent = n;
        cdMsg.textContent = CD_STEPS[5 - n];
        cdNum.classList.remove('tick'); void cdNum.offsetWidth; cdNum.classList.add('tick');
        audio.blip(880, 0.08);
        n--;
        timer = setTimeout(tick, 1000);
    };
    tick();
    logEvent('点火序列启动', 'info');
    countdownAbort = () => { clearTimeout(timer); cdEl.classList.remove('show'); sim.arming = false; countdownAbort = null; };
}

function ignite() {
    countdownAbort = null;
    sim.arming = false;
    sim.running = true;
    // 从面向镜头的发动机开始，以波的形式向全球扩散
    const camDir = _p.copy(camera.position).normalize();
    earth.updateMatrixWorld();
    let best = 0, bestDot = -2;
    const wn = new THREE.Vector3();
    engines.forEach((e, i) => {
        wn.copy(e.n).transformDirection(earth.matrixWorld);
        const d = wn.dot(camDir);
        if (d > bestDot) { bestDot = d; best = i; }
    });
    const origin = engines[best].n;
    engines.forEach((e) => {
        e.startAt = clock.elapsedTime + e.n.angleTo(origin) * 1.45 + Math.random() * 0.35;
        e.stopAt = Infinity;
    });
    shake = 1;
    updateIgniteButton();
    logEvent(`全球 ${engines.length} 台发动机点火`, 'good');
    hint.classList.add('fade');
}

function shutdown() {
    if (sim.arming) { countdownAbort?.(); updateIgniteButton(); logEvent('点火序列中止', 'warn'); return; }
    if (!sim.running) return;
    sim.running = false;
    const t = clock.elapsedTime;
    engines.forEach((e) => { e.stopAt = t + Math.random() * 1.6; e.startAt = Infinity; });
    updateIgniteButton();
    logEvent('发动机阵列熄火', 'warn');
    toast('发动机阵列 · 熄火', 'warn');
}

function setMode(m) {
    if (sim.mode === m) return;
    sim.mode = m;
    setSeg('mode', m);
    if (m === 'brake') logEvent('喷口转向 55° · 制动地球自转', 'info');
    else logEvent('喷口归位 · 全功率推进', 'info');
}

/* ---------- 镜头 ---------- */
let camMode = 'orbit';
let camTrans = null;
let focusIdx = 0;
let shake = 0;
const goal = { pos: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };

function setCam(mode) {
    if (mode === camMode && !camTrans) return;
    if (mode === 'surface') {
        // 选取面向镜头、且处于亮处的发动机
        const camDir = _p.copy(camera.position).normalize();
        earth.updateMatrixWorld();
        let bestDot = -2;
        const wn = new THREE.Vector3();
        engines.forEach((e, i) => {
            wn.copy(e.n).transformDirection(earth.matrixWorld);
            const d = wn.dot(camDir);
            if (d > bestDot) { bestDot = d; focusIdx = i; }
        });
    }
    camTrans = { from: camera.position.clone(), fromTarget: controls.target.clone(), fromUp: camera.up.clone(), t: 0, dur: mode === 'surface' || camMode === 'surface' ? 2.6 : 1.6 };
    if (mode !== 'surface') {
        const dir = camera.position.clone().normalize();
        goal.pos.copy(dir).multiplyScalar(mode === 'near' ? 20 : ORBIT_DIST);
        if (camMode === 'surface') goal.pos.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.25);
        goal.target.set(0, 0, 0);
        goal.up.set(0, 1, 0);
    }
    camMode = mode;
    controls.enabled = false;
    setSeg('cam', mode);
}

const _wp = new THREE.Vector3(), _wt = new THREE.Vector3(), _wu = new THREE.Vector3(), _side = new THREE.Vector3();
function surfaceGoal() {
    const en = engines[focusIdx];
    // 低空掠过：从发动机西侧高空沿弧形地平线望去，等离子束从冰原上拔地而起
    _wp.copy(en.n).multiplyScalar(R).addScaledVector(en.e, -5.2).addScaledVector(_side.crossVectors(en.n, en.e), 1.4);
    _wp.setLength(R + 2.3);
    _wt.copy(en.p).addScaledVector(en.n, 0.5);
    _wu.copy(_wp).normalize();
    earth.updateMatrixWorld();
    goal.pos.copy(_wp).applyMatrix4(earth.matrixWorld);
    goal.target.copy(_wt).applyMatrix4(earth.matrixWorld);
    goal.up.copy(_wu).transformDirection(earth.matrixWorld);
}

const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
function updateCamera(dt) {
    if (camMode === 'surface') surfaceGoal();
    if (camTrans) {
        camTrans.t += dt;
        const k = ease(Math.min(1, camTrans.t / camTrans.dur));
        // 方向球面插值 + 半径线性插值，避免穿过地球
        _a.copy(camTrans.from).normalize();
        _b.copy(goal.pos).normalize();
        const ang = _a.angleTo(_b);
        const len = lerp(camTrans.from.length(), goal.pos.length(), k);
        if (ang > 1e-4) {
            const axis = _p.crossVectors(_a, _b).normalize();
            _a.applyAxisAngle(axis, ang * k);
        }
        camera.position.copy(_a).multiplyScalar(len);
        controls.target.lerpVectors(camTrans.fromTarget, goal.target, k);
        camera.up.lerpVectors(camTrans.fromUp, goal.up, k).normalize();
        camera.lookAt(controls.target);
        if (camTrans.t >= camTrans.dur) {
            camTrans = null;
            if (camMode !== 'surface') { camera.up.set(0, 1, 0); controls.enabled = true; controls.update(); }
        }
    } else if (camMode === 'surface') {
        camera.position.copy(goal.pos);
        camera.up.copy(goal.up);
        controls.target.copy(goal.target);
        camera.lookAt(goal.target);
    } else {
        controls.update();
    }
    // 震动
    if (shake > 0.001 && !reduceMotion) {
        const amp = shake * (camMode === 'surface' ? 0.035 : 0.12);
        camera.position.x += (Math.random() - 0.5) * amp;
        camera.position.y += (Math.random() - 0.5) * amp;
        camera.position.z += (Math.random() - 0.5) * amp;
    }
}

/* ---------- 轨道小地图 ---------- */
const mini = $('minimap');
const mctx = mini.getContext('2d');
let miniScale = 2;
function setupMini() {
    const dpr = Math.min(devicePixelRatio, 2);
    const css = mini.clientWidth || 222;
    mini.width = mini.height = css * dpr;
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
const PLANETS = [[0.387, '#8f8f99'], [0.723, '#d8b98a'], [1.524, '#d07a55'], [J_A, '#d9b58c'], [9.54, '#e4d29c']];
function drawMini() {
    const s = mini.clientWidth || 222;
    if (!s) return;
    const c = mctx;
    const r = sim.pos.length();
    const want = Math.max(1.9, r * 1.35, sim.milestones.has('mars') ? 6.2 : 0);
    miniScale += (want - miniScale) * 0.04;
    const k = (s / 2 - 8) / miniScale;
    c.clearRect(0, 0, s, s);
    c.save();
    c.translate(s / 2, s / 2);

    // 网格
    c.strokeStyle = 'rgba(150,196,255,0.07)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(-s / 2, 0); c.lineTo(s / 2, 0); c.moveTo(0, -s / 2); c.lineTo(0, s / 2); c.stroke();

    // 行星轨道
    for (const [a, col] of PLANETS) {
        if (a * k > s) continue;
        c.strokeStyle = 'rgba(160,180,210,0.16)';
        c.setLineDash([]);
        c.beginPath(); c.arc(0, 0, a * k, 0, Math.PI * 2); c.stroke();
    }
    // 原地球轨道
    c.strokeStyle = 'rgba(115,214,255,0.35)';
    c.setLineDash([3, 4]);
    c.beginPath(); c.arc(0, 0, 1 * k, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);

    // 木星
    const jp = jupiterPos(sim.days);
    if (J_A * k < s) {
        c.fillStyle = '#e0bb8e';
        c.beginPath(); c.arc(jp.x * k, -jp.y * k, 3, 0, Math.PI * 2); c.fill();
    }

    // 太阳
    const sg = c.createRadialGradient(0, 0, 0, 0, 0, 14);
    sg.addColorStop(0, 'rgba(255,240,200,1)'); sg.addColorStop(0.3, 'rgba(255,190,90,0.7)'); sg.addColorStop(1, 'rgba(255,150,60,0)');
    c.fillStyle = sg; c.beginPath(); c.arc(0, 0, 14, 0, Math.PI * 2); c.fill();

    // 轨迹
    const tr = sim.trail;
    if (tr.length > 1) {
        c.lineWidth = 1.5;
        c.lineCap = 'round';
        const step = Math.max(1, Math.floor(tr.length / 1500));
        for (let i = step; i < tr.length; i += step) {
            const a = tr[i - step], b = tr[i];
            const t = i / tr.length;
            c.strokeStyle = `rgba(115,214,255,${0.08 + t * 0.7})`;
            c.beginPath(); c.moveTo(a.x * k, -a.y * k); c.lineTo(b.x * k, -b.y * k); c.stroke();
        }
    }

    // 地球
    const ex = sim.pos.x * k, ey = -sim.pos.y * k;
    const eg = c.createRadialGradient(ex, ey, 0, ex, ey, 10);
    eg.addColorStop(0, 'rgba(160,230,255,0.9)'); eg.addColorStop(1, 'rgba(115,214,255,0)');
    c.fillStyle = eg; c.beginPath(); c.arc(ex, ey, 10, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#e8f7ff'; c.beginPath(); c.arc(ex, ey, 2.6, 0, Math.PI * 2); c.fill();
    // 速度矢量
    const v = sim.vel.clone().normalize();
    c.strokeStyle = 'rgba(232,247,255,0.7)';
    c.beginPath(); c.moveTo(ex, ey); c.lineTo(ex + v.x * 16, ey - v.y * 16); c.stroke();
    c.restore();

    c.fillStyle = 'rgba(150,170,200,0.6)';
    c.font = '10px "JetBrains Mono", monospace';
    c.fillText('SUN', s / 2 + 8, s / 2 + 18);
    ui.orbitScale.textContent = `±${miniScale.toFixed(miniScale < 10 ? 1 : 0)} AU`;
}

/* ---------- 遥测刷新 ---------- */
let lastUi = 0;
function updateHud(now, P, eff) {
    if (now - lastUi < 0.1) return;
    lastUi = now;
    const r = sim.pos.length();
    const v = sim.vel.length();
    const vesc = Math.sqrt(2 * GM / r);
    const jd = jupiterPos(sim.days).distanceTo(sim.pos);
    ui.clock.textContent = fmtDays(sim.days);
    ui.dist.textContent = r.toFixed(3);
    ui.vel.textContent = (v * AU_YR_TO_KMS).toFixed(1);
    ui.esc.textContent = (vesc * AU_YR_TO_KMS).toFixed(1);
    ui.vel.classList.toggle('good', v >= vesc);
    if (sim.omega <= 0.0005) { ui.spinV.textContent = '停止'; ui.spinU.textContent = ''; }
    else {
        const h = 24 / sim.omega;
        ui.spinV.textContent = h > 999 ? (h / 24).toFixed(0) : h.toFixed(1);
        ui.spinU.textContent = h > 999 ? '天' : 'h';
    }
    const T = 288 / Math.sqrt(r) - 273.15 - (1 - sim.omega) * 6;
    ui.temp.textContent = T.toFixed(0);
    ui.temp.classList.toggle('warn', T < -60);
    ui.jup.textContent = jd.toFixed(2);
    ui.jup.classList.toggle('warn', jd < 0.3);
    ui.thrust.textContent = (P * engines.length * 0.0125).toFixed(2);
    ui.eff.textContent = Math.round(eff * 100);

    const brakePct = (1 - sim.omega) * 100;
    ui.mBrake.style.width = `${brakePct}%`;
    ui.mBrakeV.textContent = `${brakePct.toFixed(brakePct < 10 && brakePct > 0 ? 1 : 0)}%`;
    const escPct = Math.min(1, v / vesc) * 100;
    ui.mEsc.style.width = `${escPct}%`;
    ui.mEscV.textContent = `${escPct.toFixed(0)}%`;

    let on = 0;
    engines.forEach((e, i) => {
        const cell = gridCells[i];
        const lit = e.power > 0.5;
        if (lit && e.fault <= 0) on++;
        if (cell) {
            cell.className = e.fault > 0 ? 'fault' : (lit ? 'on' : (e.power > 0.05 ? 'warm' : ''));
        }
    });
    ui.online.textContent = on;

    // 阶段判定
    let phase = 'idle';
    const energy = v * v / 2 - GM / r;
    if (energy >= 0) phase = 'escape';
    else if (sim.running || P > 0.01 || sim.omega < 1) phase = sim.omega > 0 && sim.mode === 'brake' ? 'brake' : 'push';
    const label = { idle: '待命', brake: '制动阶段', push: '加速阶段', escape: '逃逸轨道' }[phase];
    if (phase !== sim.phase) {
        sim.phase = phase;
        ui.phase.dataset.state = phase;
        ui.phaseText.textContent = label;
    }
    if (!sim.running && P < 0.01 && phase !== 'idle' && phase !== 'escape') ui.phaseText.textContent = label + ' · 熄火';
    else ui.phaseText.textContent = label;

    milestone('stop', sim.omega <= 0, '地球自转已停止 · 进入加速阶段', 'good', () => {
        if (sim.mode === 'brake') { setMode('push'); toast('自转已停止 · 喷口自动归位', 'good'); }
    });
    milestone('half', sim.omega <= 0.5, '自转周期已延长至 48 小时', 'info');
    milestone('mars', r > 1.524, '越过火星轨道', 'info');
    milestone('escape', energy >= 0, '已达到逃逸速度 · 地球将脱离太阳系', 'good', () => toast('已达逃逸速度 · 脱离太阳引力', 'good'));
    milestone('jupiter', r > J_A, '越过木星轨道', 'info');
    milestone('jclose', jd < 0.3, '接近木星 · 引力弹弓效应', 'warn');
    milestone('cold', T < -80, '地表均温跌破 -80 °C', 'warn');
}

function milestone(key, cond, msg, level, fn) {
    if (!cond || sim.milestones.has(key)) return;
    sim.milestones.add(key);
    logEvent(msg, level);
    fn?.();
}

/* =========================================================
   声音
   ========================================================= */
const audio = {
    ctx: null, on: false,
    init() {
        if (this.ctx) return;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = this.ctx = new AC();
        this.master = ctx.createGain(); this.master.gain.value = 0; this.master.connect(ctx.destination);
        // 布朗噪声 → 低通：低沉的轰鸣
        const len = ctx.sampleRate * 3;
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        let last = 0;
        for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
        const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 90; this.lp.Q.value = 0.7;
        this.rumble = ctx.createGain(); this.rumble.gain.value = 0;
        src.connect(this.lp).connect(this.rumble).connect(this.master);
        src.start();
        const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 41;
        this.hum = ctx.createGain(); this.hum.gain.value = 0;
        osc.connect(this.hum).connect(this.master); osc.start();
        // 环境底噪
        this.amb = ctx.createGain(); this.amb.gain.value = 0.04;
        const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 320;
        const src2 = ctx.createBufferSource(); src2.buffer = buf; src2.loop = true; src2.playbackRate.value = 0.5;
        src2.connect(lp2).connect(this.amb).connect(this.master); src2.start();
    },
    toggle() {
        this.init();
        if (!this.ctx) return false;
        this.on = !this.on;
        this.ctx.resume();
        this.master.gain.setTargetAtTime(this.on ? 0.9 : 0, this.ctx.currentTime, 0.3);
        return this.on;
    },
    update(p) {
        if (!this.ctx || !this.on) return;
        const t = this.ctx.currentTime;
        this.lp.frequency.setTargetAtTime(70 + p * 380, t, 0.2);
        this.rumble.gain.setTargetAtTime(p * 0.75, t, 0.25);
        this.hum.gain.setTargetAtTime(p * 0.12, t, 0.25);
    },
    blip(freq, dur) {
        if (!this.ctx || !this.on) return;
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = 'triangle'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(this.master);
        o.start(t); o.stop(t + dur + 0.05);
    },
};

/* =========================================================
   事件绑定
   ========================================================= */
const hint = document.querySelector('.hint') || document.createElement('p');
function bindUi() {
    ui.ignite.addEventListener('click', () => (sim.running || sim.arming ? shutdown() : startIgnition()));

    const thrust = $('thrust'), thrustV = $('thrustV');
    const onThrust = () => {
        sim.thrustTarget = thrust.value / 100;
        thrustV.textContent = `${thrust.value}%`;
        thrust.style.setProperty('--p', `${thrust.value}%`);
    };
    thrust.addEventListener('input', onThrust);
    onThrust();

    $('mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.v); });
    $('speed').addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        sim.daysPerSec = Number(b.dataset.v); setSeg('speed', b.dataset.v);
    });
    $('cam').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setCam(b.dataset.v); });

    const pauseBtn = $('pause');
    const setPause = (p) => {
        sim.paused = p;
        pauseBtn.classList.toggle('paused', p);
        pauseBtn.setAttribute('aria-label', p ? '继续' : '暂停');
        pauseBtn.innerHTML = p
            ? '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>'
            : '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>';
        toast(p ? '模拟时间已暂停' : '模拟时间继续');
    };
    pauseBtn.addEventListener('click', () => setPause(!sim.paused));

    const soundBtn = $('sound');
    soundBtn.addEventListener('click', () => {
        const on = audio.toggle();
        soundBtn.setAttribute('aria-pressed', String(on));
        soundBtn.setAttribute('aria-label', on ? '关闭声音' : '开启声音');
    });

    $('reset').addEventListener('click', () => { resetSim(); toast('模拟已重置'); });

    addEventListener('keydown', (e) => {
        if (e.target instanceof HTMLInputElement && e.code !== 'Space') return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        switch (e.code) {
            case 'Space': e.preventDefault(); ui.ignite.click(); break;
            case 'Digit1': setCam('orbit'); break;
            case 'Digit2': setCam('near'); break;
            case 'Digit3': setCam('surface'); break;
            case 'KeyB': setMode('brake'); break;
            case 'KeyP': setMode('push'); break;
            case 'ArrowUp': thrust.value = Math.min(100, +thrust.value + 5); onThrust(); break;
            case 'ArrowDown': thrust.value = Math.max(0, +thrust.value - 5); onThrust(); break;
            default: break;
        }
    });

    // 已聚焦按钮上的空格键不再触发原生点击，避免与全局快捷键重复
    addEventListener('keyup', (e) => { if (e.code === 'Space' && e.target instanceof HTMLButtonElement) e.preventDefault(); });

    // 用户拖动时退出地表视角
    canvas.addEventListener('pointerdown', () => { if (camMode === 'surface' && !camTrans) setCam('near'); });

    addEventListener('resize', onResize);
    setupMini();
}

function onResize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    bloom.resolution.set(innerWidth / 2, innerHeight / 2);
    setupMini();
    applyViewOffset();
}

/* 小屏幕上把地球置于面板之间的空白区域中央 */
function applyViewOffset() {
    const tel = document.querySelector('.telemetry'), deck = document.querySelector('.deck');
    if (innerWidth > 760 || !tel || !deck) { camera.clearViewOffset(); return; }
    const top = tel.getBoundingClientRect().bottom, bottom = deck.getBoundingClientRect().top;
    const y0 = innerHeight / 2 - (top + bottom) / 2;
    camera.setViewOffset(innerWidth, innerHeight, 0, y0, innerWidth, innerHeight);
}

/* =========================================================
   主循环
   ========================================================= */
const clock = new THREE.Clock();
const SUN_DIR = new THREE.Vector3(-1, 0.1, -0.42).normalize();
let lastFault = 0;

function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    uni.uTime.value = t;

    // 发动机功率
    for (const e of engines) {
        if (sim.running && t >= e.startAt) e.power += (1 - e.power) * Math.min(1, dt * 1.6);
        else if (!sim.running && t >= e.stopAt) { e.power -= e.power * Math.min(1, dt * 1.4); if (e.power < 0.002) e.power = 0; }
        if (e.fault > 0) e.fault -= dt;
    }
    // 随机故障与自动重启
    if (sim.running && t - lastFault > 6 && Math.random() < dt * 0.06) {
        lastFault = t;
        const i = Math.floor(Math.random() * engines.length);
        if (engines[i].power > 0.9) {
            engines[i].fault = 3.5;
            logEvent(`${String(i + 1).padStart(4, '0')} 号发动机推力波动 · 自动重启`, 'warn');
        }
    }

    sim.thrust += (sim.thrustTarget - sim.thrust) * Math.min(1, dt * 2.5);
    const tiltTarget = sim.mode === 'brake' && sim.omega > 0 ? BRAKE_TILT : 0;
    sim.tilt += (tiltTarget - sim.tilt) * Math.min(1, dt * 0.9);

    const { P, eff } = sim.paused ? { P: arrayPower() * sim.thrust, eff: 1 - 0.85 * sim.omega } : stepPhysics(dt * sim.daysPerSec);
    uni.uPower.value = P;

    // 地球自转（视觉速度与真实角速度成比例）
    sim.spin += sim.omega * 0.045 * dt;
    earth.rotation.y = sim.spin;
    if (cloudMat) cloudMat.uniforms.uOff.value = (t * 0.0012) % 1;

    // 太阳方向与亮度
    const r = sim.pos.length();
    // 采用随日地连线旋转的参考系：太阳始终位于同一方向，公转轨迹见左下轨道图
    const sunDir = uni.uSunDir.value.copy(SUN_DIR);
    uni.uSun.value = Math.min(1.25, 1 / (r * r) + 0.02);
    sunLight.position.copy(sunDir).multiplyScalar(50);
    sunLight.intensity = 2.4 * uni.uSun.value;
    const sunDist = 1200;
    sunCore.position.copy(camera.position).addScaledVector(sunDir, sunDist);
    sunHalo.position.copy(sunCore.position);
    const sunSize = Math.max(14, 95 / r);
    sunCore.scale.setScalar(sunSize);
    sunHalo.scale.setScalar(sunSize * 4);
    sunHalo.material.opacity = Math.min(0.8, 0.3 + 0.5 / r);
    stars.position.copy(camera.position);

    if (engines.length) updateEngineMeshes(t, sim.thrust, sim.tilt);

    // 震动随推力
    shake = Math.max(shake * Math.pow(0.25, dt), P * 0.18);
    bloom.strength = 0.85 + P * 0.35;

    updateCamera(dt);
    composer.render();
    drawMini();
    updateHud(t, P, eff);
    audio.update(P);
    requestAnimationFrame(frame);
}

/* =========================================================
   启动
   ========================================================= */
async function init() {
    const bar = $('loaderBar'), text = $('loaderText');
    const progress = (p) => { bar.style.width = `${(p * 100).toFixed(0)}%`; };
    text.textContent = '正在生成冰封地表';
    const tex = await buildTextures(progress);
    text.textContent = '部署发动机阵列';
    progress(0.94);
    await new Promise(requestAnimationFrame);
    placeEngines();
    const maps = buildLightMaps(engines, tex.W, tex.H);
    buildEarth(tex, maps);
    buildEngineMeshes();
    buildGrid();
    bindUi();
    progress(1);
    text.textContent = '系统就绪';
    renderer.compile(scene, camera);
    requestAnimationFrame(frame);
    setTimeout(() => {
        $('loader').classList.add('done');
        $('hud').classList.add('ready');
        applyViewOffset();
        logEvent(`发动机阵列在线 · ${engines.length} 台待命`, 'info');
        logEvent('按下「点火」启动全球发动机', '');
    }, 350);
}

if (!renderer.capabilities.isWebGL2 && !renderer.getContext()) {
    $('loaderText').textContent = '当前浏览器不支持 WebGL';
} else {
    init().catch((err) => {
        console.error(err);
        $('loaderText').textContent = '初始化失败：' + err.message;
    });
}
