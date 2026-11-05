import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Particles } from './particles.js';
import { Environment } from './env.js';
import {
    PROPELLANTS, CYCLES, PRESETS, perf, evaluate, ambient, machFromArea, thermo,
} from './model.js';

const $ = (id) => document.getElementById(id);
const isSmall = matchMedia('(max-width: 760px)').matches || matchMedia('(pointer: coarse)').matches;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/* =========================================================
   状态
   ========================================================= */
const design = { ...PRESETS.sea };
let presetKey = 'sea';
let ev = evaluate(design);

const op = {
    phase: 'off',        // off | start | run | stop | fault
    t: 0,                // 当前阶段已持续时间
    power: 0,            // 实际燃烧功率 0..1
    throttle: 1, thr: 1,
    alt: 0,
    gimbal: 0, gimTarget: 0, sweep: false,
    heat: 0,             // 喷管温度 0..1
    overT: 0, hotT: 0,
    sepWarned: false,
    frost: 0, flash: 0, shut: 0, steam: 0, kick: 0,
};

/* =========================================================
   渲染器与场景
   ========================================================= */
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, isSmall ? 1.75 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.01, 2000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.enablePan = false;
controls.rotateSpeed = 0.6;
controls.zoomSpeed = 0.8;

scene.fog = new THREE.Fog(0x172a44, 20, 200);

/* 热浪扭曲：先把尾焰周围的“热区”渲染到低分辨率遮罩，再在后期按遮罩扰动画面 */
const maskRT = new THREE.WebGLRenderTarget(Math.ceil(innerWidth / 2), Math.ceil(innerHeight / 2), { type: THREE.HalfFloatType });
const shimmerPass = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, tMask: { value: null }, uTime: { value: 0 }, uAmt: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse, tMask; uniform float uTime, uAmt; varying vec2 vUv;
        void main(){
            float m = clamp(texture2D(tMask, vUv).r, 0.0, 1.0);
            vec2 o = vec2(sin(vUv.y * 160.0 + uTime * 23.0) + sin(vUv.y * 63.0 - uTime * 14.0),
                          cos(vUv.x * 120.0 - uTime * 19.0) + sin(vUv.x * 51.0 + uTime * 10.0)) * 0.5;
            gl_FragColor = texture2D(tDiffuse, vUv + o * m * uAmt);
        }`,
});
shimmerPass.uniforms.tMask.value = maskRT.texture;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(shimmerPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.75, 0.5, 0.78);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// 灯光：主光、轮廓光、尾焰补光
const key = new THREE.DirectionalLight(0xfff1e0, 1.6);
key.position.set(5, 8, 6);
const rim = new THREE.DirectionalLight(0x8fb8ff, 1.2);
rim.position.set(-6, 3, -5);
scene.add(key, rim, new THREE.AmbientLight(0x1a2333, 0.6));
const plumeLight = new THREE.PointLight(0x88aaff, 0, 0, 1.6);
const pitLight = new THREE.PointLight(0xffb070, 0, 0, 1.8);
scene.add(plumeLight, pitLight);

const env = new Environment(scene);
const smoke = new Particles(isSmall ? 380 : 700);
const sparks = new Particles(isSmall ? 160 : 280, { additive: true });
scene.add(smoke.mesh, sparks.mesh);

/* ---------- 天空（随大气密度渐变到太空） ---------- */
const sky = new THREE.Mesh(
    new THREE.SphereGeometry(900, 48, 24),
    new THREE.ShaderMaterial({
        uniforms: { uAtm: { value: 1 } },
        vertexShader: /* glsl */`
            varying vec3 vDir;
            void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`
            uniform float uAtm; varying vec3 vDir;
            void main(){
                float h = vDir.y;
                vec3 zen = mix(vec3(0.004, 0.006, 0.012), vec3(0.012, 0.025, 0.06), uAtm);
                vec3 hor = mix(vec3(0.008, 0.01, 0.02), vec3(0.07, 0.085, 0.13), uAtm);
                vec3 gnd = mix(vec3(0.005, 0.006, 0.01), vec3(0.03, 0.035, 0.045), uAtm);
                vec3 c = h > 0.0 ? mix(hor, zen, pow(h, 0.55)) : mix(hor, gnd, pow(-h, 0.4));
                gl_FragColor = vec4(c, 1.0);
            }`,
        side: THREE.BackSide, depthWrite: false,
    }),
);
scene.add(sky);

function buildStars() {
    const N = 3500;
    const pos = new Float32Array(N * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
        v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(800);
        pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: 0xcfe0ff, size: 1.3, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false });
    return new THREE.Points(g, m);
}
const stars = buildStars();
scene.add(stars);

/* =========================================================
   推进器模型
   ========================================================= */
const root = new THREE.Group();          // 固定在箭体上的推力结构
const gimbal = new THREE.Group();        // 随摆动的发动机本体
scene.add(root);
root.add(gimbal);

const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);   // 剖切：保留 x ≤ 0
let sectionOn = false;

// 再生冷却管纹理（竖向条纹）
function stripeTexture() {
    const c = document.createElement('canvas'); c.width = 512; c.height = 8;
    const g = c.getContext('2d');
    for (let x = 0; x < 512; x++) {
        const v = 0.5 + 0.5 * Math.cos((x / 512) * Math.PI * 2 * 96);
        const s = Math.round(90 + v * 140);
        g.fillStyle = `rgb(${s},${s},${s})`;
        g.fillRect(x, 0, 1, 8);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
}
const stripes = stripeTexture();

const mats = {
    regen: new THREE.MeshStandardMaterial({ color: 0x6a4c3b, metalness: 1, roughness: 0.42, bumpMap: stripes, bumpScale: 0.6, emissive: 0xff4a10, side: THREE.DoubleSide }),
    ext: new THREE.MeshStandardMaterial({ color: 0x34373e, metalness: 0.9, roughness: 0.36, emissive: 0xff3c0a, side: THREE.DoubleSide }),
    inner: new THREE.MeshStandardMaterial({ color: 0x3a2a22, metalness: 0.7, roughness: 0.55, emissive: 0xff7a30, side: THREE.BackSide }),
    steel: new THREE.MeshStandardMaterial({ color: 0xb8c0cc, metalness: 1, roughness: 0.28 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.85, roughness: 0.45 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xc9a25a, metalness: 1, roughness: 0.32 }),
    pipe: new THREE.MeshStandardMaterial({ color: 0xd2d7de, metalness: 1, roughness: 0.22 }),
    accent: new THREE.MeshStandardMaterial({ color: 0x1b2a3c, metalness: 0.6, roughness: 0.4, emissive: 0x2a8cff, emissiveIntensity: 0 }),
    reactor: new THREE.MeshStandardMaterial({ color: 0x5d636d, metalness: 0.95, roughness: 0.36 }),
    cut: new THREE.MeshStandardMaterial({ color: 0xc98a5a, metalness: 0.6, roughness: 0.45, side: THREE.DoubleSide }),
};
const clippable = ['regen', 'ext', 'inner', 'steel', 'dark', 'gold', 'pipe', 'accent', 'reactor'];
const GOLD = new THREE.Color(0xc9a25a), PIPE = new THREE.Color(0xd2d7de), FROST = new THREE.Color(0xc9d3de);

/* 喷管发热：按黑体辐射色阶着色（暗红 → 橙 → 黄白），权重来自沿母线的发光贴图 */
function heatify(mat) {
    mat.userData.uHeat = { value: 0 };
    mat.emissive.set(0xffffff);
    mat.onBeforeCompile = (sh) => {
        sh.uniforms.uHeat = mat.userData.uHeat;
        sh.fragmentShader = 'uniform float uHeat;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>', `
            #ifdef USE_EMISSIVEMAP
                float hw = texture2D(emissiveMap, vEmissiveMapUv).r;
                float T = clamp(hw * uHeat, 0.0, 1.25);
                vec3 bb = mix(vec3(0.3, 0.01, 0.0), vec3(1.0, 0.18, 0.02), smoothstep(0.0, 0.45, T));
                bb = mix(bb, vec3(1.0, 0.55, 0.18), smoothstep(0.45, 0.85, T));
                bb = mix(bb, vec3(1.0, 0.88, 0.66), smoothstep(0.85, 1.2, T));
                totalEmissiveRadiance = bb * pow(T, 2.4) * 6.0;
            #endif`);
    };
    mat.customProgramCacheKey = () => 'heat';
    return mat;
}
mats.cut.polygonOffset = true; mats.cut.polygonOffsetFactor = -1;

/* 由型面权重生成沿母线方向的发光贴图（与 LatheGeometry 的 v 坐标对齐） */
function profileTexture(weights) {
    const n = weights.length;
    const c = document.createElement('canvas'); c.width = 2; c.height = n;
    const g = c.getContext('2d');
    for (let j = 0; j < n; j++) {
        const s = Math.round(clamp(weights[j], 0, 1) * 255);
        g.fillStyle = `rgb(${s},${s},${s})`;
        g.fillRect(0, n - 1 - j, 2, 1);   // flipY：v=0 位于画布底部
    }
    return new THREE.CanvasTexture(c);
}

/* LatheGeometry 需要自下而上的点序才能得到朝外的法线 */
function lathe(pts, seg = 72) {
    return new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(Math.max(p.r, 1e-4), p.y)), seg);
}

function tube(points, radius, mat) {
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    return new THREE.Mesh(new THREE.TubeGeometry(curve, 48, radius, 10, false), mat);
}

let hw = new THREE.Group();        // 当前硬件
let geo = null;                    // 当前几何参数
let actuators = [];
let ggPlume = null;
gimbal.add(hw);

function disposeGroup(g) {
    g.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material.userData.own) { o.material.map?.dispose(); o.material.dispose(); }
    });
}

function buildEngine(d) {
    disposeGroup(hw);
    gimbal.remove(hw);
    hw = new THREE.Group();
    gimbal.add(hw);
    for (const a of actuators) { scene.remove(a.sleeve, a.rod); a.sleeve.geometry.dispose(); a.rod.geometry.dispose(); }
    actuators = [];

    const c = ev.c;
    const { rt, re, rc } = c;
    const isNtr = d.prop === 'ntr';
    const mount = rc * (isNtr ? 1.9 : 1.15);
    const yInj = -mount;
    const pts = c.pts.map((p) => ({ y: yInj + p.z, r: p.r, part: p.part }));
    const yt = yInj + c.zt;
    const yExit = pts[pts.length - 1].y;
    const wallC = rt * 0.16, wallE = Math.max(rt * 0.035, 0.004);

    // 再生冷却段与辐射冷却延伸段的分界（面积比 ≈ 16 处）
    const epsRegen = Math.min(d.eps, isNtr ? 30 : 16);
    let split = pts.findIndex((p) => p.part === 'div' && (p.r / rt) ** 2 >= epsRegen);
    if (split < 0) split = pts.length - 1;
    const hasExt = split < pts.length - 2;

    const thick = (p, i) => (i <= split ? wallC * (p.part === 'div' ? lerp(1, 0.55, (p.y - yt) / (pts[split].y - yt || 1)) : 1) : wallE);

    // 外壁：再生段
    const regenOuter = pts.slice(0, split + 1).map((p, i) => ({ y: p.y, r: p.r + thick(p, i) }));
    regenOuter.unshift({ y: yInj + rt * 0.02, r: rc * 0.94 + wallC });
    const regenW = regenOuter.map((p) => 0.05 + 0.45 * Math.exp(-Math.abs(p.y - yt) / (rt * 2.2)));
    const regenMesh = new THREE.Mesh(lathe([...regenOuter].reverse()), heatify(mats.regen.clone()));
    regenMesh.material.userData.own = true;
    regenMesh.material.emissiveMap = profileTexture([...regenW].reverse());
    regenMesh.material.bumpMap = stripes;
    hw.add(regenMesh);

    // 外壁：辐射冷却延伸段
    let extMesh = null;
    if (hasExt) {
        const ext = pts.slice(split).map((p) => ({ y: p.y, r: p.r + wallE }));
        const extW = ext.map((_, i) => Math.pow(1 - 0.8 * (i / (ext.length - 1)), 1.6));
        extMesh = new THREE.Mesh(lathe([...ext].reverse()), heatify(mats.ext.clone()));
        extMesh.material.userData.own = true;
        extMesh.material.emissiveMap = profileTexture([...extW].reverse());
        hw.add(extMesh);
        // 加强环
        const ring = new THREE.Mesh(new THREE.TorusGeometry(pts[split].r + wallC * 0.7, wallC * 0.45, 10, 72), mats.steel);
        ring.rotation.x = Math.PI / 2; ring.position.y = pts[split].y;
        hw.add(ring);
    }
    // 出口唇缘
    const lip = new THREE.Mesh(new THREE.TorusGeometry(re + wallE, Math.max(wallE * 1.2, rt * 0.03), 8, 96), mats.dark);
    lip.rotation.x = Math.PI / 2; lip.position.y = yExit;
    hw.add(lip);

    // 内壁（自喷注器到出口），喉部最热
    const innerW = pts.map((p) => {
        if (p.part === 'div') return 0.25 + 0.75 * Math.exp(-Math.abs(p.y - yt) / (rt * 3.5));
        return p.part === 'conv' ? 0.95 : 0.85;
    });
    const innerMesh = new THREE.Mesh(lathe([...pts].reverse()), mats.inner.clone());
    innerMesh.material.userData.own = true;
    innerMesh.material.emissiveMap = profileTexture([...innerW].reverse());
    hw.add(innerMesh);

    // 剖切面（壁厚截面）：只在剖面模式显示
    const cutGroup = new THREE.Group();
    for (const side of [1, -1]) {
        const pos = [];
        const outer = (i) => pts[i].r + thick(pts[i], i);
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            const ai = a.r * side, ao = outer(i) * side, bi = b.r * side, bo = outer(i + 1) * side;
            pos.push(0, a.y, ai, 0, a.y, ao, 0, b.y, bi, 0, b.y, bi, 0, a.y, ao, 0, b.y, bo);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.computeVertexNormals();
        cutGroup.add(new THREE.Mesh(g, mats.cut));
    }
    cutGroup.visible = sectionOn;
    cutGroup.name = 'cut';
    hw.add(cutGroup);

    // 流场剖面（马赫数着色 + 流线条纹）
    const flow = buildFlowPlane(d, pts, yt);
    flow.visible = sectionOn;
    hw.add(flow);

    // 喷注器顶盖 / 反应堆
    if (isNtr) {
        const vessel = new THREE.Mesh(new THREE.CylinderGeometry(rc * 1.55, rc * 1.55, c.lc + rc * 1.2, 64, 1), mats.reactor);
        vessel.position.y = yInj - c.lc / 2 + rc * 0.45;
        hw.add(vessel);
        for (let k = 0; k < 3; k++) {
            const band = new THREE.Mesh(new THREE.TorusGeometry(rc * 1.57, rc * 0.05, 8, 64), mats.gold);
            band.rotation.x = Math.PI / 2;
            band.position.y = yInj + rc * 0.6 - k * (c.lc + rc * 0.6) / 2.4;
            hw.add(band);
        }
        const shield = new THREE.Mesh(new THREE.CylinderGeometry(rc * 1.75, rc * 1.75, rc * 0.28, 64), mats.dark);
        shield.position.y = yInj + rc * 1.15;
        hw.add(shield);
        const glowRing = new THREE.Mesh(new THREE.TorusGeometry(rc * 1.58, rc * 0.025, 6, 64), mats.accent);
        glowRing.rotation.x = Math.PI / 2; glowRing.position.y = yInj - c.lc * 0.5;
        hw.add(glowRing);
    } else {
        const dome = lathe([
            { y: yInj - rt * 0.05, r: rc + wallC },
            { y: yInj + rc * 0.18, r: rc * 0.98 },
            { y: yInj + rc * 0.42, r: rc * 0.7 },
            { y: yInj + rc * 0.55, r: rc * 0.32 },
            { y: yInj + rc * 0.62, r: 0.0001 },
        ], 64);
        hw.add(new THREE.Mesh(dome, mats.steel));
        const mani = new THREE.Mesh(new THREE.TorusGeometry(rc * 1.02, rc * 0.11, 12, 72), mats.steel);
        mani.rotation.x = Math.PI / 2; mani.position.y = yInj + rc * 0.05;
        hw.add(mani);
    }

    // 推力锥 + 万向节轴承
    const coneTop = rc * 0.22, coneBot = rc * 0.75;
    const coneLen = mount - (isNtr ? rc * 1.3 : rc * 0.6);
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(coneTop, coneBot, coneLen, 32, 1, true), mats.dark);
    cone.position.y = -coneLen / 2;
    hw.add(cone);
    const bearing = new THREE.Mesh(new THREE.SphereGeometry(rc * 0.26, 32, 16), mats.steel);
    hw.add(bearing);

    // 涡轮泵
    const pumpR = clamp(0.12 * Math.pow(ev.vac.mdot, 0.3) * (isNtr ? 0.8 : 1), rc * 0.32, rc * 0.62);
    const pumpH = pumpR * 2.4;
    const pumps = isNtr ? [{ side: 1, mat: mats.steel }] : [{ side: 1, mat: mats.steel }, { side: -1, mat: mats.gold }];
    const pumpY = yInj - c.lc * 0.15 - pumpH * 0.35;
    const pumpZ = (isNtr ? rc * 1.55 : rc) + pumpR * 1.45;
    const manifoldY = yInj + rc * 0.05;
    for (const p of pumps) {
        const g = new THREE.Group();
        g.position.set(-rc * 0.35, pumpY, p.side * pumpZ);
        const body = new THREE.Mesh(new THREE.CylinderGeometry(pumpR * 0.62, pumpR * 0.7, pumpH, 32), mats.dark);
        const volute = new THREE.Mesh(new THREE.TorusGeometry(pumpR * 0.78, pumpR * 0.28, 14, 40), p.mat);
        volute.rotation.x = Math.PI / 2; volute.position.y = pumpH * 0.28;
        const turbine = new THREE.Mesh(new THREE.CylinderGeometry(pumpR * 0.86, pumpR * 0.86, pumpH * 0.22, 32), mats.steel);
        turbine.position.y = -pumpH * 0.3;
        const inlet = new THREE.Mesh(new THREE.CylinderGeometry(pumpR * 0.32, pumpR * 0.42, pumpH * 0.5, 20), p.mat);
        inlet.position.y = pumpH * 0.68;
        const light = new THREE.Mesh(new THREE.TorusGeometry(pumpR * 0.64, pumpR * 0.03, 6, 40), mats.accent);
        light.rotation.x = Math.PI / 2; light.position.y = pumpH * 0.05;
        g.add(body, volute, turbine, inlet, light);
        hw.add(g);

        // 主管路：泵出口 → 燃烧室集液环
        const out = new THREE.Vector3(-rc * 0.35, pumpY + pumpH * 0.28, p.side * (pumpZ - pumpR * 0.9));
        hw.add(tube([
            out,
            new THREE.Vector3(-rc * 0.3, pumpY + pumpH * 0.55, p.side * (pumpZ - pumpR * 0.6)),
            new THREE.Vector3(-rc * 0.2, manifoldY + rc * 0.25, p.side * (rc * 1.25)),
            new THREE.Vector3(-rc * 0.1, manifoldY + rc * 0.1, p.side * (rc * 1.02)),
        ], pumpR * 0.2, p.mat));
    }
    // 冷却剂管：泵 → 再生段入口集液环
    const regenY = pts[split].y;
    const regenR = pts[split].r + wallC;
    const coolRing = new THREE.Mesh(new THREE.TorusGeometry(regenR + rt * 0.1, rt * 0.12, 10, 72), mats.steel);
    coolRing.rotation.x = Math.PI / 2; coolRing.position.y = regenY + rt * 0.25;
    hw.add(coolRing);
    hw.add(tube([
        new THREE.Vector3(-rc * 0.35 - pumpR * 0.5, pumpY - pumpH * 0.1, pumpZ - pumpR * 0.4),
        new THREE.Vector3(-rc * 0.5, pumpY - pumpH * 0.6, pumpZ * 0.8),
        new THREE.Vector3(-regenR * 0.6, regenY + rt * 0.6, regenR * 0.9),
        new THREE.Vector3(-regenR * 0.35, regenY + rt * 0.25, regenR + rt * 0.1),
    ], rt * 0.1, mats.pipe));

    // 燃气发生器循环：涡轮废气排气管
    ggPlume = null;
    if (d.cycle === 'gg') {
        const ey = yt - c.ln * 0.35;
        const rAt = (y) => { let best = pts[0]; for (const p of pts) if (Math.abs(p.y - y) < Math.abs(best.y - y)) best = p; return best.r; };
        const ex = new THREE.Vector3(-rc * 0.35, ey, rAt(ey) + pumpR * 0.9 + rt * 0.3);
        hw.add(tube([
            new THREE.Vector3(-rc * 0.35, pumpY - pumpH * 0.35, pumpZ),
            new THREE.Vector3(-rc * 0.35, pumpY - pumpH * 0.9, pumpZ),
            new THREE.Vector3(-rc * 0.35, lerp(pumpY, ey, 0.6), lerp(pumpZ, ex.z, 0.5)),
            ex,
        ], pumpR * 0.24, mats.dark));
        ggPlume = makePlume(true);
        ggPlume.group.position.copy(ex);
        hw.add(ggPlume.group);
    } else {
        // 分级燃烧：热燃气导管直通喷注器
        hw.add(tube([
            new THREE.Vector3(-rc * 0.35, pumpY - pumpH * 0.3, pumpZ * 0.92),
            new THREE.Vector3(-rc * 0.6, yInj + rc * 0.2, rc * 0.9),
            new THREE.Vector3(-rc * 0.3, yInj + rc * 0.52, rc * 0.25),
        ], pumpR * 0.3, mats.steel));
    }

    // 摆动作动器（固定端在箭体上，活动端在燃烧室上）
    for (const s of [1, -1]) {
        const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(rc * 0.09, rc * 0.09, 1, 16), mats.dark);
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(rc * 0.05, rc * 0.05, 1, 12), mats.steel);
        scene.add(sleeve, rod);
        actuators.push({
            sleeve, rod,
            fixed: new THREE.Vector3(rc * 0.2, rc * 0.15, s * rc * 1.45),
            move: new THREE.Vector3(rc * 0.2, yInj - c.lc * 0.35, s * (rc + wallC + rc * 0.05)),
        });
    }

    // 箭体安装板（固定）
    root.children.filter((o) => o.name === 'plate').forEach((o) => { o.geometry.dispose(); root.remove(o); });
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(rc * 1.9, rc * 1.9, rc * 0.14, 6), mats.dark);
    plate.position.y = rc * 0.22;
    plate.name = 'plate';
    root.add(plate);

    applyClipping();

    const vents = [];
    for (const p of pumps) vents.push(new THREE.Vector3(-rc * 0.35, pumpY + pumpH * 0.95, p.side * pumpZ));
    vents.push(new THREE.Vector3(-regenR * 0.5, regenY + rt * 0.5, regenR * 0.9));
    vents.push(new THREE.Vector3(-rc * 0.2, manifoldY + rc * 0.2, rc * 1.15));

    geo = { yInj, yt, yExit, rt, re, rc, pts, extMesh, regenMesh, innerMesh, cutGroup, flow, vents, pumpR, height: -yExit + rc * 0.4 };
    plume.group.position.y = yExit;
    env.build({ H: -yExit, yExit, re, rc, plateY: rc * 0.29 });
}

/* ---------- 流场剖面 ---------- */
const flowMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uRun: { value: 0 }, uFlowT: { value: 0 } },
    vertexShader: /* glsl */`
        attribute float aMach; attribute float aTransit; attribute float aEdge;
        varying float vMach; varying float vTransit; varying float vEdge;
        void main(){ vMach = aMach; vTransit = aTransit; vEdge = aEdge; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
        uniform float uTime, uRun, uFlowT;
        varying float vMach; varying float vTransit; varying float vEdge;
        vec3 turbo(float t){
            t = clamp(t, 0.0, 1.0);
            return clamp(vec3(
                0.13572138 + t*(4.61539260 + t*(-42.66032258 + t*(132.13108234 + t*(-152.94239396 + t*59.28637943)))),
                0.09140261 + t*(2.19418839 + t*(4.84296658 + t*(-14.18503333 + t*(4.27729857 + t*2.82956604)))),
                0.10667330 + t*(12.64194608 + t*(-60.58204836 + t*(110.36276771 + t*(-89.90310912 + t*27.34824973))))), 0.0, 1.0);
        }
        void main(){
            vec3 c = turbo(vMach);
            float streak = smoothstep(0.75, 1.0, fract(vTransit * 14.0 - uFlowT)) * uRun;
            float wall = smoothstep(0.82, 1.0, vEdge);
            c *= 0.55 + 0.45 * uRun;
            c += streak * 0.35 * (1.0 - wall);
            c *= 1.0 - wall * 0.35;
            gl_FragColor = vec4(c * 0.9, 1.0);
        }`,
    side: THREE.DoubleSide,
});

function buildFlowPlane(d, pts, yt) {
    const { g } = thermo(d.prop, d.of);
    const rt = ev.c.rt;
    const Me = machFromArea(d.eps, g);
    const n = pts.length;
    const mach = pts.map((p) => {
        const ar = (p.r / rt) ** 2;
        const sup = p.part === 'div';
        return machFromArea(Math.max(ar, 1.0001), g, sup);
    });
    // 沿轴向累计流经时间（u ∝ M·√T）
    const transit = [0];
    for (let i = 1; i < n; i++) {
        const M = (mach[i] + mach[i - 1]) / 2;
        const u = M / Math.sqrt(1 + (g - 1) / 2 * M * M);
        transit.push(transit[i - 1] + Math.abs(pts[i].y - pts[i - 1].y) / Math.max(u, 0.05) / rt);
    }
    const tMax = transit[n - 1];
    const COLS = 9;
    const pos = [], aM = [], aT = [], aE = [], idx = [];
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < COLS; k++) {
            const f = k / (COLS - 1) * 2 - 1;
            pos.push(-0.0005, pts[i].y, f * pts[i].r);
            aM.push(Math.log(1 + mach[i]) / Math.log(1 + Me) * 0.92 + 0.04);
            aT.push(transit[i] / tMax * 6 + Math.abs(f) * 0.05);
            aE.push(Math.abs(f));
        }
    }
    for (let i = 0; i < n - 1; i++) {
        for (let k = 0; k < COLS - 1; k++) {
            const a = i * COLS + k, b = a + 1, c2 = a + COLS, d2 = c2 + 1;
            idx.push(a, c2, b, b, c2, d2);
        }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('aMach', new THREE.Float32BufferAttribute(aM, 1));
    geom.setAttribute('aTransit', new THREE.Float32BufferAttribute(aT, 1));
    geom.setAttribute('aEdge', new THREE.Float32BufferAttribute(aE, 1));
    geom.setIndex(idx);
    const m = new THREE.Mesh(geom, flowMat);
    m.name = 'flow';
    return m;
}

function applyClipping() {
    for (const k of clippable) mats[k].clippingPlanes = sectionOn ? [clipPlane] : null;
    hw.traverse((o) => {
        if (o.material && o.material.userData.own) o.material.clippingPlanes = sectionOn ? [clipPlane] : null;
        if (o.material) o.material.needsUpdate = true;
    });
    for (const a of actuators) { a.sleeve.visible = a.rod.visible = true; }
    if (geo) { geo.cutGroup.visible = sectionOn; geo.flow.visible = sectionOn; }
    hw.children.forEach((o) => { if (o.name === 'cut' || o.name === 'flow') o.visible = sectionOn; });
}

/* =========================================================
   尾焰
   ========================================================= */
const PLUME_STYLE = {
    methalox: { core: [0.42, 0.55, 1.0], edge: [0.62, 0.36, 1.0], dia: [1.0, 0.82, 0.95], burn: [1.0, 0.42, 0.2], bright: 1.0, shock: 1.0 },
    hydrolox: { core: [0.5, 0.62, 1.0], edge: [0.4, 0.48, 1.0], dia: [1.0, 0.86, 0.78], burn: [0.6, 0.6, 1.0], bright: 0.42, shock: 1.6 },
    kerolox: { core: [1.0, 0.62, 0.26], edge: [1.0, 0.38, 0.1], dia: [1.0, 0.9, 0.7], burn: [1.0, 0.34, 0.08], bright: 1.05, shock: 0.8 },
    ntr: { core: [0.72, 0.82, 1.0], edge: [0.5, 0.6, 1.0], dia: [0.9, 0.92, 1.0], burn: [0.5, 0.6, 1.0], bright: 0.3, shock: 0.4 },
};

const plumeVS = /* glsl */`
    uniform float uRe, uLen, uK, uAtm, uDiam, uSep, uTime, uScale;
    varying float vS; varying vec3 vN; varying vec3 vV; varying float vAng;
    float shape(float s){
        float x = s * uLen / uRe;
        float under = max(uK - 1.0, 0.0);
        float spread = 1.0 + min(sqrt(under) * 0.32, 3.2) * (1.0 - exp(-x * 0.45));
        spread += x * (0.035 * uAtm + 0.16 * (1.0 - uAtm));
        float over = max(1.0 - uK, 0.0) * uAtm;
        spread *= 1.0 - over * 0.42 * (1.0 - exp(-x * 1.1));
        float osc = sin(6.2831 * s / uDiam) * exp(-s * 2.2) * 0.09 * uAtm * min(abs(uK - 1.0) + 0.35, 1.0);
        spread *= 1.0 + osc;
        spread *= mix(1.0, 0.72, uSep);
        return max(spread, 0.15);
    }
    void main(){
        float s = 0.5 - position.y;
        vS = s;
        float ang = atan(position.z, position.x);
        vAng = ang;
        float r = uRe * uScale * shape(s);
        r *= 1.0 + uSep * 0.22 * sin(ang + uTime * 23.0) * smoothstep(0.0, 0.3, s);
        vec3 p = vec3(position.x * r, -s * uLen, position.z * r);
        p.x += uSep * sin(uTime * 17.0) * s * uRe * 0.6;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * vec3(position.x, 0.0, position.z));
        vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
    }`;

const plumeFS = /* glsl */`
    uniform float uTime, uPower, uAtm, uDiam, uBright, uShock, uLayer, uK, uBurn, uSep, uFlash, uShut;
    uniform vec3 uCore, uEdge, uDia, uBurnCol, uFlashCol;
    varying float vS; varying vec3 vN; varying vec3 vV; varying float vAng;
    float hh(vec3 p){ p = fract(p * 0.3183 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float vn(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(hh(i),hh(i+vec3(1,0,0)),f.x),mix(hh(i+vec3(0,1,0)),hh(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(hh(i+vec3(0,0,1)),hh(i+vec3(1,0,1)),f.x),mix(hh(i+vec3(0,1,1)),hh(i+vec3(1,1,1)),f.x),f.y),f.z); }
    void main(){
        if (uPower < 0.003) discard;
        float s = vS;
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float body = pow(facing, uLayer > 0.5 ? 2.4 : 1.3);
        float fall = pow(1.0 - s, mix(2.6, 1.6, uAtm));
        float t = uTime;
        float turb = 0.7 + 0.3 * sin(s * 42.0 - t * 30.0 + vAng * 3.0) * sin(s * 13.0 - t * 11.0 - vAng * 2.0);
        float dia = 0.0;
        for (int i = 1; i <= 7; i++) {
            float c = float(i) * uDiam;
            dia += exp(-pow((s - c) / (uDiam * 0.085), 2.0)) * exp(-float(i) * 0.32);
        }
        dia *= uAtm * uShock * smoothstep(0.0, 0.25, abs(uK - 1.0) + 0.1) * pow(facing, 3.0);
        float exitGlow = exp(-s * 30.0) * 0.8;
        vec3 col = mix(uCore, uEdge, clamp(s * 1.3 + (1.0 - facing) * 0.6, 0.0, 1.0));
        float burn = uBurn * uAtm * smoothstep(0.08, 0.5, s) * (1.0 - facing) * (uLayer > 0.5 ? 1.0 : 0.0);
        col = mix(col, uBurnCol, burn);
        col = mix(col, vec3(1.0, 0.42, 0.12), uShut * 0.85);
        col = mix(col, uFlashCol, uFlash);
        float I = (fall * turb * body + exitGlow * body) * uBright * uPower;
        I *= uLayer > 0.5 ? 0.55 : 1.0;
        if (uLayer > 0.5) {
            // 外层湍流边缘：随流动被噪声侵蚀
            float n = vn(vec3(cos(vAng) * 2.0 + 3.0, sin(vAng) * 2.0 + s * 16.0 - t * 8.0, t * 0.6));
            I *= 0.35 + 1.3 * n * n;
        }
        I *= 1.0 + uFlash * 2.5 + uShut * 0.6 * sin(t * 40.0) * sin(t * 23.0);
        vec3 outc = col * I + uDia * dia * 1.8 * uPower;
        float a = clamp(I + dia, 0.0, 1.0);
        gl_FragColor = vec4(outc, a);
    }`;

function makePlume(small = false) {
    const g = new THREE.CylinderGeometry(1, 1, 1, 48, small ? 40 : 160, true);
    const group = new THREE.Group();
    const layers = [];
    for (const layer of [0, 1]) {
        const u = {
            uRe: { value: 1 }, uLen: { value: 10 }, uK: { value: 1 }, uAtm: { value: 1 }, uDiam: { value: 0.1 },
            uSep: { value: 0 }, uTime: { value: 0 }, uScale: { value: layer ? 1.0 : 0.6 },
            uPower: { value: 0 }, uBright: { value: 1 }, uShock: { value: 1 }, uLayer: { value: layer }, uBurn: { value: 0 },
            uCore: { value: new THREE.Color() }, uEdge: { value: new THREE.Color() }, uDia: { value: new THREE.Color() }, uBurnCol: { value: new THREE.Color() },
            uFlash: { value: 0 }, uShut: { value: 0 }, uFlashCol: { value: new THREE.Color(1, 1, 1) },
        };
        const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
            uniforms: u, vertexShader: plumeVS, fragmentShader: plumeFS,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        }));
        m.frustumCulled = false;
        m.renderOrder = 2;
        group.add(m);
        layers.push(u);
    }
    // 喷口光盘
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.ShaderMaterial({
        uniforms: { uPower: { value: 0 }, uCol: { value: new THREE.Color() } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'uniform float uPower; uniform vec3 uCol; varying vec2 vUv; void main(){ float d = length(vUv-0.5)*2.0; float a = (1.0 - d*d) * uPower; gl_FragColor = vec4(uCol * a * 1.6, a); }',
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    disc.rotation.x = Math.PI / 2;
    disc.position.y = -0.002;
    group.add(disc);
    // 热浪遮罩（仅渲染到第 1 层）
    let shimmer = null;
    if (!small) {
        const u = layers[1];
        shimmer = new THREE.Mesh(g, new THREE.ShaderMaterial({
            uniforms: { ...u, uScale: { value: 1.9 } },
            vertexShader: plumeVS,
            fragmentShader: /* glsl */`
                uniform float uPower, uAtm; varying float vS; varying vec3 vN; varying vec3 vV;
                void main(){
                    float f = abs(dot(normalize(vN), normalize(vV)));
                    float m = uPower * uAtm * pow(1.0 - vS, 1.4) * f * 0.6;
                    gl_FragColor = vec4(vec3(m), 1.0);
                }`,
            transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        }));
        shimmer.layers.set(1);
        shimmer.frustumCulled = false;
        group.add(shimmer);
    }
    return { group, layers, disc, shimmer };
}
const plume = makePlume();
gimbal.add(plume.group);

const _c1 = new THREE.Color(), _c2 = new THREE.Color();
function updatePlume(P, power, time) {
    const st = PLUME_STYLE[design.prop];
    const atm = clamp(P.pa / 101325, 0, 1);
    const atmV = Math.pow(atm, 0.35);
    const k = P.pa > 0 ? clamp(P.pe / P.pa, 0.05, 400) : 400;
    const re = ev.c.re;
    const De = re * 2;
    const len = De * (4.5 + 5.5 * op.thr) * (1 + 1.6 * (1 - atmV));
    const spacing = De * (0.55 + 0.4 * Math.sqrt(clamp(k, 0.2, 4))) * Math.sqrt(Math.max(P.Me * P.Me - 1, 1)) * 0.32;
    const x = design.prop === 'ntr' ? 0 : design.of / PROPELLANTS[design.prop].ofOpt - 1;
    const sep = P.separated ? clamp((0.4 * P.pa - P.pe) / (0.4 * P.pa) * 2 + 0.35, 0, 1) : 0;
    for (const u of plume.layers) {
        u.uRe.value = re;
        u.uLen.value = len;
        u.uK.value = k;
        u.uAtm.value = atmV;
        u.uDiam.value = clamp(spacing / len, 0.03, 0.4);
        u.uSep.value = sep;
        u.uTime.value = time;
        u.uPower.value = power;
        u.uBright.value = st.bright * (0.5 + 0.35 * atmV) * (0.75 + 0.25 * op.thr) * (atmV < 0.05 ? 0.75 : 1);
        u.uShock.value = st.shock;
        u.uBurn.value = clamp(0.35 - x * 1.2, 0, 1) * (design.prop === 'hydrolox' || design.prop === 'ntr' ? 0.2 : 1);
        u.uCore.value.setRGB(...st.core);
        // 偏富燃 → 尾焰偏暖
        _c1.setRGB(...st.edge); _c2.setRGB(1, 0.5, 0.2);
        u.uEdge.value.copy(_c1).lerp(_c2, clamp(-x * 1.6, 0, 0.6));
        u.uDia.value.setRGB(...st.dia);
        u.uBurnCol.value.setRGB(...st.burn);
        u.uFlash.value = op.flash;
        u.uShut.value = op.shut;
        // 煤油发动机用 TEA-TEB 点火剂，点火瞬间是标志性的绿色闪光
        if (design.prop === 'kerolox') u.uFlashCol.value.setRGB(0.25, 1.0, 0.35); else u.uFlashCol.value.setRGB(1.0, 0.92, 0.85);
    }
    plume.disc.scale.setScalar(re * 0.98);
    plume.disc.material.uniforms.uPower.value = power * (0.25 + 0.3 * st.bright);
    plume.disc.material.uniforms.uCol.value.setRGB(...st.core);

    if (ggPlume) {
        for (const u of ggPlume.layers) {
            u.uRe.value = ev.c.rt * 0.45;
            u.uLen.value = ev.c.re * 5 * (1 + (1 - atmV));
            u.uK.value = 1.5; u.uAtm.value = atmV; u.uDiam.value = 0.2; u.uTime.value = time;
            u.uPower.value = power * 0.8; u.uBright.value = 1.3; u.uShock.value = 0; u.uBurn.value = 0.8;
            u.uCore.value.setRGB(1, 0.6, 0.25); u.uEdge.value.setRGB(0.8, 0.3, 0.1); u.uBurnCol.value.setRGB(0.5, 0.2, 0.08);
        }
        ggPlume.disc.material.uniforms.uPower.value = 0;
    }

    plumeLight.color.setRGB(...st.core);
    plumeLight.intensity = power * st.bright * 7 * re * re;
    plumeLight.distance = 0;
    plume.group.getWorldPosition(plumeLight.position);
    plumeLight.position.y -= re * 2;
    // 导流槽内的反光
    pitLight.color.setRGB(...st.core).lerp(_c2.setRGB(1, 0.6, 0.35), 0.4);
    pitLight.intensity = power * atm * st.bright * 22 * Math.max(re, 0.5) ** 2;
    if (env.d) pitLight.position.copy(env.emit.mouth).add(env.stand.position).setY(env.gy + env.stand.position.y + 0.5);
}

/* =========================================================
   镜头
   ========================================================= */
let viewMode = 'overview';
let camTrans = null;
let curH = 3;
const VIEWS = {
    overview: { dir: new THREE.Vector3(1.0, 0.16, 1.15), dist: 2.25, ty: 0.78 },
    nozzle: { dir: new THREE.Vector3(0.75, -1.15, 0.9), dist: 1.55, ty: 0.92 },
    section: { dir: new THREE.Vector3(1.0, 0.04, 0.08), dist: 1.75, ty: 0.55 },
};
const free = { w: innerWidth, h: innerHeight };
/* 按可视区域自动取景：保证发动机在面板之间完整可见 */
function fitScale(H) {
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const De = (geo ? geo.re : ev.c.re) * 2;
    const needH = H * 1.25 * innerHeight / (0.82 * free.h * 2 * tanV);
    const needW = Math.max(De, (geo ? geo.rc : ev.c.rc) * 5) * 1.25 * innerHeight / (0.86 * free.w * 2 * tanV);
    return Math.max(1, Math.max(needH, needW) / (H * VIEWS.overview.dist));
}
function viewGoal(mode, H) {
    const v = VIEWS[mode];
    const target = new THREE.Vector3(0, -H * v.ty + H * 0.1, 0);
    const pos = v.dir.clone().normalize().multiplyScalar(H * v.dist * fitScale(H)).add(target);
    return { pos, target };
}
function setView(mode) {
    viewMode = mode;
    const g = viewGoal(mode, curH);
    camTrans = { fromPos: camera.position.clone(), fromT: controls.target.clone(), to: g, t: 0, dur: 1.2 };
    controls.enabled = false;
    sectionOn = mode === 'section';
    applyClipping();
    $('labels').classList.toggle('show', sectionOn);
    for (const b of $('cam').children) b.setAttribute('aria-checked', String(b.dataset.v === mode));
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function updateCamera(dt) {
    const H = geo ? geo.height : ev.height;
    const prevH = curH;
    curH = lerp(curH, H, Math.min(1, dt * 4));
    controls.minDistance = curH * 0.5;
    controls.maxDistance = curH * 9;
    if (camTrans) {
        camTrans.t += dt;
        const k = ease(Math.min(1, camTrans.t / camTrans.dur));
        const to = viewGoal(viewMode, curH);
        camera.position.lerpVectors(camTrans.fromPos, to.pos, k);
        controls.target.lerpVectors(camTrans.fromT, to.target, k);
        camera.lookAt(controls.target);
        if (k >= 1) { camTrans = null; controls.enabled = true; }
    } else {
        // 设计尺寸变化时，按比例缩放镜头距离
        if (Math.abs(curH - prevH) > 1e-5) {
            const ratio = curH / prevH;
            const off = camera.position.clone().sub(controls.target).multiplyScalar(ratio);
            controls.target.y *= ratio;
            camera.position.copy(controls.target).add(off);
        }
        controls.update();
    }
    // 震动
    const shake = (op.power * (0.0025 + (lastP?.separated ? 0.01 : 0)) + op.kick * 0.012) * curH * (reduceMotion ? 0 : 1);
    if (shake > 0) {
        camera.position.x += (Math.random() - 0.5) * shake;
        camera.position.y += (Math.random() - 0.5) * shake;
    }
}

/* 把模型放在面板之间的空白区域中央 */
function applyViewOffset() {
    const W = innerWidth, H = innerHeight;
    let left = 0, right = W, top = 0, bottom = H;
    const focus = document.body.classList.contains('focus');
    if (focus) {
        if (W > 760) bottom = document.querySelector('.deck').getBoundingClientRect().top;
        top = document.querySelector('.brand').getBoundingClientRect().bottom * (W > 760 ? 0 : 1);
    } else if (W > 760) {
        const d = document.querySelector('.design').getBoundingClientRect();
        const p = document.querySelector('.perf').getBoundingClientRect();
        const k = document.querySelector('.deck').getBoundingClientRect();
        left = d.right; right = p.left; bottom = k.top;
    } else {
        top = document.querySelector('.brand').getBoundingClientRect().bottom;
        bottom = document.querySelector('.tabs').getBoundingClientRect().top;
    }
    free.w = right - left; free.h = bottom - top;
    const x0 = W / 2 - (left + right) / 2;
    const y0 = H / 2 - (top + bottom) / 2;
    camera.setViewOffset(W, H, x0, y0, W, H);
    // 竖屏时可视区较窄，适当拉宽视场
    const freeW = right - left, freeH = bottom - top;
    camera.fov = freeW < freeH ? 50 : 38;
    camera.updateProjectionMatrix();
}

/* =========================================================
   剖面标注
   ========================================================= */
const labelEls = {};
function ensureLabels() {
    const box = $('labels');
    for (const k of ['inj', 'ch', 'throat', 'exit', 'legend']) {
        if (labelEls[k]) continue;
        const s = document.createElement('span');
        if (k === 'legend') s.className = 'mach-legend';
        box.appendChild(s);
        labelEls[k] = s;
    }
}
const _lp = new THREE.Vector3();
function updateLabels() {
    if (!sectionOn || !geo) return;
    ensureLabels();
    const P = ev.vac;
    const anchors = {
        inj: [geo.yInj + geo.rc * 0.1, geo.rc * 0.6, '喷注器', ''],
        ch: [geo.yInj - ev.c.lc * 0.5, geo.rc, '燃烧室', `${design.pc.toFixed(1)} MPa · ${P.Tc.toFixed(0)} K`],
        throat: [geo.yt, geo.rt, '喉部', `Ø ${(geo.rt * 2).toFixed(2)} m · Ma 1`],
        exit: [geo.yExit, geo.re, '喷管出口', `Ø ${(geo.re * 2).toFixed(2)} m · Ma ${P.Me.toFixed(1)}`],
    };
    gimbal.updateMatrixWorld();
    for (const [k, [y, r, name, val]] of Object.entries(anchors)) {
        _lp.set(0, y, r * 1.08).applyMatrix4(gimbal.matrixWorld).project(camera);
        const el = labelEls[k];
        const x = (_lp.x * 0.5 + 0.5) * innerWidth, yy = (-_lp.y * 0.5 + 0.5) * innerHeight;
        el.style.transform = `translate(${x.toFixed(1)}px, ${(yy - 8).toFixed(1)}px)`;
        el.innerHTML = `${name} <i>${val}</i>`;
    }
    labelEls.legend.innerHTML = `<b>马赫数 0 – ${P.Me.toFixed(1)}</b><em></em>`;
}

/* =========================================================
   界面
   ========================================================= */
const el = (id) => $(id);
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');

function setSlider(id, v) {
    const input = $(id);
    input.value = v;
    paintSlider(input);
}
function paintSlider(input) {
    const p = (input.value - input.min) / (input.max - input.min) * 100;
    input.style.setProperty('--p', `${p}%`);
}

function syncDesignUi() {
    const prop = PROPELLANTS[design.prop];
    for (const b of $('prop').children) b.setAttribute('aria-checked', String(b.dataset.v === design.prop));
    for (const b of $('cycle').children) {
        b.disabled = !prop.cycles.includes(b.dataset.v);
        b.setAttribute('aria-checked', String(b.dataset.v === design.cycle));
    }
    const ofIn = $('of');
    if (prop.of) {
        ofIn.min = prop.of[0]; ofIn.max = prop.of[1];
        $('ofRow').classList.remove('disabled');
    } else {
        $('ofRow').classList.add('disabled');
    }
    setSlider('pc', design.pc);
    setSlider('of', prop.of ? design.of : ofIn.min);
    setSlider('dt', design.dt);
    setSlider('eps', design.eps);
    setSlider('bell', Math.round(design.bell * 100));
    $('pcV').value = design.pc.toFixed(1);
    $('ofV').value = prop.of ? design.of.toFixed(2) : '—';
    $('dtV').value = design.dt.toFixed(2);
    $('epsV').value = design.eps.toFixed(0);
    $('bellV').value = Math.round(design.bell * 100);
    const cyc = CYCLES[design.cycle];
    $('designTag').textContent = `${prop.short} · ${cyc.short}`;
    $('cycleHint').textContent = `${cyc.name} · 室压上限 ${cyc.pcMax} MPa` + (design.prop === 'ntr' ? ' · 反应堆加热氢工质' : '');
    $('pc').classList.toggle('over', design.pc > cyc.pcMax);
    for (const b of $('presets').children) b.classList.toggle('active', b.dataset.k === presetKey);
}

let rebuildQueued = false;
function designChanged(fromPreset = false) {
    if (!fromPreset) presetKey = null;
    const prop = PROPELLANTS[design.prop];
    if (!prop.cycles.includes(design.cycle)) design.cycle = prop.cycles[prop.cycles.length > 2 ? 2 : 0];
    if (prop.of) design.of = clamp(design.of, prop.of[0], prop.of[1]);
    ev = evaluate(design);
    syncDesignUi();
    updateStaticPerf();
    drawChart();
    if (!rebuildQueued) {
        rebuildQueued = true;
        requestAnimationFrame(() => { rebuildQueued = false; buildEngine(design); });
    }
}

function updateStaticPerf() {
    $('pFsl').textContent = fmt(ev.sl.F / 1e3);
    $('pFvac').textContent = fmt(ev.vac.F / 1e3);
    $('pIspSl').textContent = fmt(ev.sl.Isp);
    $('pIspVac').textContent = fmt(ev.vac.Isp);
    $('pIspSl').className = ev.sl.separated ? 'bad' : '';
    $('pTc').textContent = fmt(ev.vac.Tc);
    $('pTw').textContent = fmt(ev.twSL, 1);
    $('pTw').className = ev.twSL < 1 ? 'bad' : (ev.twSL < 20 ? 'warn' : '');
    $('pHi').textContent = ev.vac.pe >= 101325 ? '< 0' : fmt(ev.hIdeal, 1);
    $('gExit').textContent = `${(ev.c.re * 2).toFixed(2)} m`;
    $('gLen').textContent = `${ev.height.toFixed(2)} m`;
    $('gMass').textContent = `${fmt(ev.mass)} kg`;

    const load = ev.load;
    $('mLoad').style.width = `${Math.min(100, load * 100)}%`;
    $('mLoad').className = load > 1 ? 'bad' : (load > 0.9 ? 'warn' : '');
    $('mLoadV').textContent = `${Math.round(load * 100)}%`;
    const cm = ev.coolMargin;
    $('mCool').style.width = `${clamp(cm / 1.5, 0, 1) * 100}%`;
    $('mCool').className = cm < 0 ? 'bad' : (cm < 0.1 ? 'warn' : 'cool');
    $('mCoolV').textContent = `${cm >= 0 ? '+' : ''}${Math.round(cm * 100)}%`;

    renderWarnings();
}

function renderWarnings() {
    const list = [];
    const cyc = CYCLES[design.cycle];
    if (ev.load > 1) list.push(['bad', `室压超出${cyc.name}的涡轮泵能力（上限 ${cyc.pcMax} MPa），点火后将超速关机`]);
    else if (ev.load > 0.9) list.push(['warn', '涡轮泵接近满负荷，寿命与可靠性下降']);
    if (ev.coolMargin < 0) list.push(['bad', '喉部热流超出再生冷却能力，长时间工作会烧穿']);
    else if (ev.coolMargin < 0.1) list.push(['warn', '冷却裕度偏小，建议降低室压或改用氢工质']);
    const slNow = perf(design, ambient(0), op.throttle);
    if (slNow.separated) list.push(['warn', '海平面工作时喷管内发生流动分离：侧向载荷大，此设计只适合高空或真空']);
    if (design.eps < 12) list.push(['warn', '膨胀比偏小，真空中大量能量随欠膨胀的燃气浪费']);
    if (design.prop === 'ntr') list.push(['good', '核热推进：比冲约为化学发动机的两倍，但推重比很低，适合深空巡航']);
    if (design.cycle === 'gg') list.push(['', '燃气发生器循环：涡轮废气直接排出，结构简单但损失约 3% 比冲']);
    if (!list.some(([c]) => c === 'bad' || c === 'warn')) list.push(['good', `设计可行 · 真空比冲 ${fmt(ev.vac.Isp)} s，推重比 ${fmt(ev.twVac, 0)}`]);
    $('warnings').innerHTML = list.map(([c, t]) => `<li class="${c}">${t}</li>`).join('');
}

/* 推力—高度曲线 */
const chart = $('chart');
const cctx = chart.getContext('2d');
function drawChart() {
    const dpr = Math.min(devicePixelRatio, 2);
    const W = chart.clientWidth || 288, H = chart.clientHeight || 120;
    if (chart.width !== Math.round(W * dpr)) { chart.width = Math.round(W * dpr); chart.height = Math.round(H * dpr); }
    const c = cctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const pad = { l: 34, r: 8, t: 8, b: 18 };
    const N = 80;
    const data = [];
    let fMax = 0;
    for (let i = 0; i <= N; i++) {
        const h = i / N * 100;
        const P = perf(design, ambient(h), op.throttle);
        data.push({ h, F: P.F, sep: P.separated });
        fMax = Math.max(fMax, P.F);
    }
    fMax *= 1.1;
    const X = (h) => pad.l + h / 100 * (W - pad.l - pad.r);
    const Y = (f) => pad.t + (1 - f / fMax) * (H - pad.t - pad.b);
    // 网格
    c.strokeStyle = 'rgba(160,196,240,0.08)';
    c.lineWidth = 1;
    c.font = '9px "JetBrains Mono", monospace';
    c.fillStyle = 'rgba(155,169,191,0.7)';
    for (let i = 0; i <= 2; i++) {
        const f = fMax / 1.1 * i / 2;
        const y = Y(f);
        c.beginPath(); c.moveTo(pad.l, y); c.lineTo(W - pad.r, y); c.stroke();
        c.fillText(f >= 1e6 ? `${(f / 1e6).toFixed(1)}M` : `${(f / 1e3).toFixed(0)}k`, 2, y + 3);
    }
    for (const h of [0, 25, 50, 75, 100]) c.fillText(h === 100 ? '真空' : `${h}`, X(h) - (h === 100 ? 20 : 4), H - 4);
    // 分离区
    c.fillStyle = 'rgba(255,95,109,0.16)';
    for (let i = 0; i < N; i++) if (data[i].sep) c.fillRect(X(data[i].h), pad.t, X(data[i + 1].h) - X(data[i].h) + 0.5, H - pad.t - pad.b);
    // 理想膨胀高度
    if (ev.hIdeal > 0 && ev.hIdeal < 100) {
        c.strokeStyle = 'rgba(111,240,180,0.5)';
        c.setLineDash([2, 3]);
        c.beginPath(); c.moveTo(X(ev.hIdeal), pad.t); c.lineTo(X(ev.hIdeal), H - pad.b); c.stroke();
        c.setLineDash([]);
    }
    // 曲线
    const grad = c.createLinearGradient(0, pad.t, 0, H - pad.b);
    grad.addColorStop(0, 'rgba(120,212,255,0.28)'); grad.addColorStop(1, 'rgba(120,212,255,0)');
    c.beginPath();
    data.forEach((d, i) => (i ? c.lineTo(X(d.h), Y(d.F)) : c.moveTo(X(d.h), Y(d.F))));
    c.lineTo(X(100), H - pad.b); c.lineTo(X(0), H - pad.b); c.closePath();
    c.fillStyle = grad; c.fill();
    c.beginPath();
    data.forEach((d, i) => (i ? c.lineTo(X(d.h), Y(d.F)) : c.moveTo(X(d.h), Y(d.F))));
    c.strokeStyle = '#78d4ff'; c.lineWidth = 1.6; c.stroke();
    // 当前高度
    const P = perf(design, ambient(op.alt), op.throttle);
    const cx = X(op.alt), cy = Y(P.F);
    c.strokeStyle = 'rgba(232,238,248,0.35)';
    c.beginPath(); c.moveTo(cx, pad.t); c.lineTo(cx, H - pad.b); c.stroke();
    c.fillStyle = '#e8f7ff';
    c.beginPath(); c.arc(cx, cy, 3.2, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(120,212,255,0.6)'; c.lineWidth = 4;
    c.beginPath(); c.arc(cx, cy, 6, 0, Math.PI * 2); c.stroke();
}

let lastP = null;
let lastUi = 0;
function updateLivePerf(now) {
    const P = perf(design, ambient(op.alt), op.thr);
    lastP = P;
    if (now - lastUi < 0.08) return P;
    lastUi = now;
    const on = op.power > 0.02;
    $('pF').textContent = on ? fmt(P.F * op.power / 1e3) : '0';
    $('pIsp').textContent = on ? fmt(P.Isp) : '—';
    $('pMdot').textContent = fmt(P.mdot * (on ? op.power : 1));
    $('pVe').textContent = fmt(P.ve);
    $('pPe').textContent = fmt(P.pe / 1e3, 1);
    $('pPa').textContent = P.pa > 0 ? fmt(P.pa / 1e3, P.pa < 1000 ? 2 : 1) : '0';
    $('pMe').textContent = fmt(P.Me, 2);

    const flow = $('flow');
    let st, txt;
    if (P.separated) { st = 'sep'; txt = '流动分离'; }
    else if (P.pa === 0) { st = 'under'; txt = '真空 · 欠膨胀'; }
    else {
        const k = P.pe / P.pa;
        if (k > 1.15) { st = 'under'; txt = `欠膨胀 ×${k.toFixed(1)}`; }
        else if (k < 0.87) { st = 'over'; txt = `过膨胀 ×${k.toFixed(2)}`; }
        else { st = 'ideal'; txt = '理想膨胀'; }
    }
    flow.dataset.state = st;
    flow.textContent = txt;
    return P;
}

/* ---------- 状态与提示 ---------- */
let toastTimer;
function toast(msg, level = '') {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast show ${level}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
function setStatus(state, text) {
    const s = $('status');
    s.dataset.state = state;
    $('statusText').textContent = text;
}
function updateIgnite() {
    const running = op.phase === 'start' || op.phase === 'run';
    $('ignite').classList.toggle('running', running);
    $('ignite').setAttribute('aria-pressed', String(running));
    $('igniteText').textContent = running ? '关机' : '点火';
    $('igniteSub').textContent = running ? 'CUTOFF' : 'IGNITE';
}

function ignite() {
    if (op.phase === 'start' || op.phase === 'run') return;
    op.phase = 'start'; op.t = 0;
    op.overT = 0; op.hotT = 0; op.sepWarned = false;
    updateIgnite();
    audio.blip(660, 0.1);
    $('hint').classList.add('fade');
}
function cutoff(reason) {
    if (op.phase !== 'start' && op.phase !== 'run') return;
    op.phase = reason ? 'fault' : 'stop';
    op.t = 0;
    op.shut = 1;
    if (reason) sparkBurst(70, 1.4);
    updateIgnite();
    if (reason) { toast(reason, 'bad'); setStatus('fault', '紧急关机'); audio.blip(220, 0.4); }
    else setStatus('off', '关机');
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
        const len = ctx.sampleRate * 3;
        const brown = ctx.createBuffer(1, len, ctx.sampleRate);
        const white = ctx.createBuffer(1, len, ctx.sampleRate);
        const b = brown.getChannelData(0), w = white.getChannelData(0);
        let last = 0;
        for (let i = 0; i < len; i++) {
            const r = Math.random() * 2 - 1;
            last = (last + 0.02 * r) / 1.02; b[i] = last * 3.5;
            w[i] = r * (Math.random() < 0.02 ? 1 : 0.25);
        }
        const loop = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };
        this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 120;
        this.roar = ctx.createGain(); this.roar.gain.value = 0;
        loop(brown).connect(this.lp).connect(this.roar).connect(this.master);
        this.bp = ctx.createBiquadFilter(); this.bp.type = 'bandpass'; this.bp.frequency.value = 1800; this.bp.Q.value = 0.6;
        this.crackle = ctx.createGain(); this.crackle.gain.value = 0;
        loop(white).connect(this.bp).connect(this.crackle).connect(this.master);
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 180;
        const of = ctx.createBiquadFilter(); of.type = 'lowpass'; of.frequency.value = 600;
        this.whine = ctx.createGain(); this.whine.gain.value = 0; this.osc = o;
        o.connect(of).connect(this.whine).connect(this.master); o.start();
    },
    toggle() {
        this.init();
        if (!this.ctx) return false;
        this.on = !this.on;
        this.ctx.resume();
        this.master.gain.setTargetAtTime(this.on ? 0.9 : 0, this.ctx.currentTime, 0.2);
        return this.on;
    },
    update(power, atm, pump) {
        if (!this.ctx || !this.on) return;
        const t = this.ctx.currentTime;
        this.lp.frequency.setTargetAtTime(90 + power * 500, t, 0.1);
        this.roar.gain.setTargetAtTime(power * (0.35 + 0.5 * atm), t, 0.12);
        this.crackle.gain.setTargetAtTime(power * atm * 0.35, t, 0.12);
        this.osc.frequency.setTargetAtTime(160 + pump * 900, t, 0.3);
        this.whine.gain.setTargetAtTime(pump * 0.035, t, 0.2);
    },
    blip(freq, dur) {
        if (!this.ctx || !this.on) return;
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = 'triangle'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.05);
    },
};

/* =========================================================
   事件
   ========================================================= */
function bindUi() {
    // 预设
    const pre = $('presets');
    pre.innerHTML = Object.entries(PRESETS).map(([k, p]) => `<button data-k="${k}">${p.name}</button>`).join('');
    pre.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        Object.assign(design, PRESETS[b.dataset.k]);
        presetKey = b.dataset.k;
        designChanged(true);
        toast(`已载入：${PRESETS[b.dataset.k].name}`);
    });

    $('prop').addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b || b.dataset.v === design.prop) return;
        design.prop = b.dataset.v;
        const p = PROPELLANTS[design.prop];
        if (p.of) design.of = p.ofOpt;
        if (design.prop === 'ntr') { design.pc = Math.min(design.pc, 7); design.eps = Math.max(design.eps, 100); }
        designChanged();
    });
    $('cycle').addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b || b.disabled) return;
        design.cycle = b.dataset.v;
        designChanged();
    });

    const bindRange = (id, fn) => {
        const input = $(id);
        input.addEventListener('input', () => { paintSlider(input); fn(Number(input.value)); designChanged(); });
    };
    bindRange('pc', (v) => { design.pc = v; });
    bindRange('of', (v) => { design.of = v; });
    bindRange('dt', (v) => { design.dt = v; });
    bindRange('eps', (v) => { design.eps = v; });
    bindRange('bell', (v) => { design.bell = v / 100; });

    const thr = $('throttle');
    thr.addEventListener('input', () => { op.throttle = thr.value / 100; $('thrV').value = thr.value; paintSlider(thr); drawChart(); renderWarnings(); });
    const alt = $('alt');
    const onAlt = () => {
        op.alt = Number(alt.value);
        $('altV').value = op.alt >= 99.9 ? '真空' : (op.alt === 0 ? '海平面' : `${op.alt.toFixed(1)} km`);
        paintSlider(alt);
        drawChart();
    };
    alt.addEventListener('input', onAlt);
    const gim = $('gimbal');
    gim.addEventListener('input', () => { op.gimTarget = Number(gim.value); op.sweep = false; $('sweep').setAttribute('aria-pressed', 'false'); paintSlider(gim); });

    $('cam').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); });
    $('ignite').addEventListener('click', () => (op.phase === 'start' || op.phase === 'run' ? cutoff() : ignite()));

    $('sound').addEventListener('click', () => {
        const on = audio.toggle();
        $('sound').setAttribute('aria-pressed', String(on));
        $('sound').setAttribute('aria-label', on ? '关闭声音' : '开启声音');
    });
    $('sweep').addEventListener('click', () => {
        op.sweep = !op.sweep;
        $('sweep').setAttribute('aria-pressed', String(op.sweep));
        if (!op.sweep) { op.gimTarget = 0; setSlider('gimbal', 0); }
        toast(op.sweep ? '摆动测试：±6° 正弦扫描' : '摆动测试结束');
    });

    // 专注模式：收起面板，只看发动机
    const setFocus = (on) => {
        document.body.classList.toggle('focus', on);
        $('focus').setAttribute('aria-pressed', String(on));
        applyViewOffset();
        setView(viewMode);
    };
    $('focus').addEventListener('click', () => setFocus(!document.body.classList.contains('focus')));
    $('focusExit').addEventListener('click', () => setFocus(false));
    addEventListener('keydown', (e) => {
        if (e.code === 'KeyF' && !e.metaKey && !e.ctrlKey && !e.altKey) setFocus(!document.body.classList.contains('focus'));
        if (e.code === 'Escape' && document.body.classList.contains('focus')) setFocus(false);
    });

    // 移动端标签页
    document.querySelector('.tabs').addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        document.body.dataset.tab = b.dataset.tab;
        for (const t of document.querySelectorAll('.tabs button')) t.setAttribute('aria-selected', String(t === b));
        if (b.dataset.tab === 'perf') drawChart();
    });

    addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const inRange = e.target instanceof HTMLInputElement;
        switch (e.code) {
            case 'Space': e.preventDefault(); $('ignite').click(); break;
            case 'Digit1': setView('overview'); break;
            case 'Digit2': setView('nozzle'); break;
            case 'Digit3': setView('section'); break;
            case 'ArrowLeft': if (!inRange) { op.gimTarget = clamp(op.gimTarget - 1, -8, 8); setSlider('gimbal', op.gimTarget); } break;
            case 'ArrowRight': if (!inRange) { op.gimTarget = clamp(op.gimTarget + 1, -8, 8); setSlider('gimbal', op.gimTarget); } break;
            default: break;
        }
    });
    addEventListener('keyup', (e) => { if (e.code === 'Space' && e.target instanceof HTMLButtonElement) e.preventDefault(); });

    addEventListener('resize', onResize);
    for (const id of ['throttle', 'alt', 'gimbal']) paintSlider($(id));
    onAlt();
}

function onResize() {
    camera.aspect = innerWidth / innerHeight;
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    bloom.resolution.set(innerWidth / 2, innerHeight / 2);
    maskRT.setSize(Math.ceil(innerWidth / 2), Math.ceil(innerHeight / 2));
    applyViewOffset();
    drawChart();
}

/* =========================================================
   主循环
   ========================================================= */
const clock = new THREE.Clock();
let flowT = 0;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _mid = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _q = new THREE.Quaternion();

function stepOps(dt, P) {
    op.t += dt;
    op.thr = lerp(op.thr, op.throttle, Math.min(1, dt * 3));
    let pump = 0;
    switch (op.phase) {
        case 'start': {
            const t = op.t;
            if (t < 0.7) { setStatus('start', '预冷'); pump = t / 0.7 * 0.2; op.power = 0; }
            else if (t < 1.4) { setStatus('start', '涡轮泵起旋'); pump = 0.2 + (t - 0.7) / 0.7 * 0.6; op.power = 0; }
            else {
                if (op.power === 0) { audio.blip(330, 0.3); igniteBurst(); }
                setStatus('start', '点火'); pump = 0.85;
                op.power = Math.min(1, (t - 1.4) / 0.9);
                op.power *= 0.75 + 0.25 * Math.random();
                if (t > 2.3) { op.phase = 'run'; op.t = 0; op.power = 1; toast('主级工作 · 推力建立', 'good'); }
            }
            break;
        }
        case 'run': {
            setStatus('run', '主级工作');
            pump = 0.85 + 0.15 * op.thr;
            op.power = lerp(op.power, 1, Math.min(1, dt * 5));
            // 故障判据
            if (ev.load > 1.04) { op.overT += dt; if (op.overT > 2.5) cutoff('涡轮泵超速 · 自动关机'); }
            if (ev.coolMargin < -0.04) { op.hotT += dt; if (op.hotT > 4) cutoff('喉部过热 · 自动关机'); }
            if (P.separated && !op.sepWarned) { op.sepWarned = true; toast('流动分离 · 侧向载荷过大', 'warn'); }
            break;
        }
        case 'stop':
        case 'fault':
            op.power = Math.max(0, op.power - dt * (op.phase === 'fault' ? 2.5 : 1.3));
            pump = op.power;
            if (op.power === 0 && op.phase === 'stop') { op.phase = 'off'; setStatus('off', '冷态'); }
            if (op.power === 0 && op.phase === 'fault' && op.t > 2.5) { op.phase = 'off'; setStatus('off', '冷态'); }
            break;
        default:
            op.power = 0;
    }
    // 低温结霜：预冷时迅速结霜，工作中保持，关机后缓慢融化
    if (op.phase === 'start') op.frost = Math.min(1, op.frost + dt * 1.1);
    else if (op.phase === 'run') op.frost = lerp(op.frost, 0.8, dt * 0.3);
    else op.frost = Math.max(0, op.frost - dt * 0.04);
    op.flash = Math.max(0, op.flash - dt * 3.2);
    op.shut = op.phase === 'stop' || op.phase === 'fault' ? Math.min(op.shut, op.power + 0.15) : Math.max(0, op.shut - dt * 2);
    op.kick = Math.max(0, op.kick - dt * 2.5);
    // 水汽余量：关机后导流槽里的蒸汽还会翻滚一阵
    op.steam = Math.max(op.power, op.steam - dt * 0.18);
    // 喷管温度：热时间常数约 3 秒
    const heatTarget = op.power * (0.55 + 0.45 * (1 - Math.pow(clamp(P.pa / 101325, 0, 1), 0.35))) * (P.Tc / 3500) * (0.7 + 0.3 * op.thr);
    op.heat = lerp(op.heat, heatTarget, Math.min(1, dt / (heatTarget > op.heat ? 3 : 6)));
    // 摆动
    if (op.sweep) { op.gimTarget = Math.sin(clock.elapsedTime * 2.2) * 6; setSlider('gimbal', op.gimTarget.toFixed(1)); }
    op.gimbal = lerp(op.gimbal, op.gimTarget, Math.min(1, dt * 6));
    $('gimV').value = op.gimbal.toFixed(1);
    return pump;
}

function updateActuators() {
    gimbal.updateMatrixWorld();
    for (const a of actuators) {
        _a.copy(a.fixed).applyMatrix4(root.matrixWorld);
        _b.copy(a.move).applyMatrix4(gimbal.matrixWorld);
        const len = _a.distanceTo(_b);
        _mid.subVectors(_b, _a).normalize();
        _q.setFromUnitVectors(_up, _mid);
        a.sleeve.quaternion.copy(_q); a.rod.quaternion.copy(_q);
        a.sleeve.scale.set(1, len * 0.55, 1);
        a.sleeve.position.copy(_a).addScaledVector(_mid, len * 0.275);
        a.rod.scale.set(1, len * 0.5, 1);
        a.rod.position.copy(_b).addScaledVector(_mid, -len * 0.25);
        a.sleeve.material = mats.dark; a.rod.material = mats.steel;
    }
}

/* ---------- 粒子：火花、冰屑、预冷白雾、导流槽烟云 ---------- */
const _w = new THREE.Vector3(), _e = new THREE.Vector3();
const rand = (a, b) => a + Math.random() * (b - a);

function sparkBurst(n, speed = 1) {
    if (!geo) return;
    plume.group.getWorldPosition(_e);
    const re = geo.re;
    const green = design.prop === 'kerolox';
    for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * re * 0.9;
        const out = rand(1.5, 7) * Math.max(re, 0.4) * speed;
        sparks.spawn({
            p: [_e.x + Math.cos(a) * r, _e.y - rand(0, re * 0.3), _e.z + Math.sin(a) * r],
            v: [Math.cos(a) * out, -rand(2, 9) * Math.max(re, 0.4) * speed, Math.sin(a) * out],
            life: rand(0.5, 1.3), s0: Math.max(re * 0.035, 0.03), s1: Math.max(re * 0.01, 0.01),
            col: green && Math.random() < 0.5 ? [0.4, 1, 0.45] : [1, rand(0.45, 0.75), 0.2],
            drag: 0.6, buoy: -9.8, a: 1, rotV: 0,
        });
    }
}

function igniteBurst() {
    op.flash = 1;
    op.kick = 1;
    sparkBurst(isSmall ? 70 : 130, 1.2);
    // 点火震动震落管路上的冰屑
    if (!geo) return;
    gimbal.updateMatrixWorld();
    for (let i = 0; i < 46; i++) {
        const v = geo.vents[i % geo.vents.length];
        _w.copy(v).applyMatrix4(gimbal.matrixWorld);
        smoke.spawn({
            p: [_w.x + rand(-1, 1) * geo.rc * 0.4, _w.y - rand(0, geo.rc), _w.z + rand(-1, 1) * geo.rc * 0.4],
            v: [rand(-0.6, 0.6), rand(-0.5, 0.8), rand(-0.6, 0.6)],
            life: rand(0.8, 1.5), s0: geo.rc * rand(0.05, 0.1), s1: geo.rc * 0.05,
            col: [1, 1, 1], drag: 0.3, buoy: -9.8, a: 0.95, rotV: 3,
        });
    }
}

let acc = { vapor: 0, mouth: 0, outlet: 0, spark: 0 };
function emitParticles(dt, P, atm) {
    if (!geo || !env.d) return;
    const rc = geo.rc;
    // 预冷/低温白雾：冷气下沉
    const vaporRate = op.phase === 'start' ? 70 : (op.frost > 0.2 ? 10 * op.frost : 0);
    acc.vapor += vaporRate * dt * (atm > 0.05 ? 1 : 0);
    if (acc.vapor >= 1) gimbal.updateMatrixWorld();
    while (acc.vapor >= 1) {
        acc.vapor -= 1;
        const v = geo.vents[Math.floor(Math.random() * geo.vents.length)];
        _w.copy(v).applyMatrix4(gimbal.matrixWorld);
        smoke.spawn({
            p: [_w.x + rand(-1, 1) * rc * 0.15, _w.y, _w.z + rand(-1, 1) * rc * 0.15],
            v: [rand(-0.25, 0.25) * rc * 2, rand(-0.8, -0.2) * rc * 2, rand(-0.25, 0.25) * rc * 2],
            life: rand(1.4, 2.6), s0: rc * 0.25, s1: rc * rand(1.0, 1.8),
            col: [0.95, 0.97, 1], drag: 1.4, buoy: -0.25 * rc, a: 0.32,
        });
    }

    // 导流槽烟云（只在地面附近）
    const ground = env.stand.visible ? Math.max(0, 1 - op.alt / 1.2) : 0;
    const intensity = op.steam * ground;
    if (intensity > 0.01) {
        const sc = Math.max(env.emit.width, 2);
        const off = env.stand.position;
        acc.outlet += (isSmall ? 18 : 30) * intensity * dt;
        while (acc.outlet >= 1) {
            acc.outlet -= 1;
            const o = env.emit.outlet;
            const sp = rand(6, 14) * sc * 0.35 * (0.4 + 0.6 * op.power);
            smoke.spawn({
                p: [o.x + off.x, o.y + off.y + rand(0, env.emit.depth * 0.5), o.z + rand(-0.5, 0.5) * sc],
                v: [sp * env.emit.dir.x, rand(0.5, 2.5) * sc * 0.3, rand(-1, 1) * sp * 0.35],
                life: rand(4, 7), s0: sc * 0.7, s1: sc * rand(3.5, 5.5),
                col: [0.8, 0.8, 0.82], drag: 0.45, buoy: 0.6 * sc * 0.3, a: 0.32 * Math.min(1, intensity * 1.5),
                heat: op.power * 0.25,
            });
        }
        acc.mouth += (isSmall ? 5 : 8) * intensity * dt;
        while (acc.mouth >= 1) {
            acc.mouth -= 1;
            const m = env.emit.mouth;
            smoke.spawn({
                p: [m.x + off.x + sc * rand(1, 2.5) * env.emit.dir.x, m.y + off.y, m.z + rand(-0.3, 0.3) * sc],
                v: [rand(2, 5) * sc * 0.4 * env.emit.dir.x, rand(1, 3) * sc * 0.3, rand(-1, 1) * sc * 0.3],
                life: rand(3, 5), s0: sc * 0.5, s1: sc * rand(2, 3),
                col: [0.82, 0.82, 0.84], drag: 0.6, buoy: 0.25 * sc * 0.3, a: 0.2 * Math.min(1, intensity * 1.5),
                heat: op.power * 0.4,
            });
        }
    }
    // 点火过渡中的零星火花
    if (op.phase === 'start' && op.power > 0) {
        acc.spark += 60 * dt;
        if (acc.spark >= 4) { sparkBurst(Math.floor(acc.spark), 0.8); acc.spark = 0; }
    }

    // 烟云受尾焰照亮
    const st = PLUME_STYLE[design.prop];
    const u = smoke.uniforms;
    u.uLightPos.value.copy(env.emit.mouth).add(env.stand.position);
    u.uLightI.value = op.power * (0.6 + st.bright) * 0.55;
    u.uFalloff.value = 1 / Math.pow(Math.max(env.emit.width, 2) * 2.5, 2);
    u.uLightCol.value.setRGB(...st.core).lerp(_c2.setRGB(1, 0.62, 0.35), 0.5);
    u.uAmb.value.setRGB(lerp(0.06, 0.16, atm), lerp(0.07, 0.18, atm), lerp(0.09, 0.22, atm));
}

/* ---------- 热浪遮罩 ---------- */
function renderShimmer(t, atm) {
    const amt = op.power * atm;
    shimmerPass.uniforms.uTime.value = t;
    shimmerPass.uniforms.uAmt.value = amt * 0.0032;
    shimmerPass.enabled = amt > 0.01;
    if (!shimmerPass.enabled) return;
    const prevBg = scene.background;
    camera.layers.set(1);
    renderer.setRenderTarget(maskRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    camera.layers.set(0);
    scene.background = prevBg;
}

function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    const P = updateLivePerf(t);
    const pump = stepOps(dt, P);
    const atm = Math.pow(clamp(P.pa / 101325, 0, 1), 0.35);

    gimbal.rotation.x = THREE.MathUtils.degToRad(op.gimbal);
    updatePlume(P, op.power, t);
    updateActuators();

    // 发热与指示灯
    if (geo) {
        const h = op.heat;
        geo.regenMesh.material.userData.uHeat.value = h * 0.62;
        if (geo.extMesh) geo.extMesh.material.userData.uHeat.value = h * 1.08;
        geo.innerMesh.material.emissiveIntensity = op.power * 0.8 + h * 0.7;
    }
    mats.accent.emissiveIntensity = 0.12 + pump * 0.9;
    mats.gold.color.lerpColors(GOLD, FROST, op.frost * 0.85);
    mats.gold.roughness = lerp(0.32, 0.9, op.frost);
    mats.pipe.color.lerpColors(PIPE, FROST, op.frost * 0.6);
    mats.pipe.roughness = lerp(0.22, 0.8, op.frost);

    // 流场动画
    flowT += dt * (0.4 + op.power * 2.6 * op.thr);
    flowMat.uniforms.uFlowT.value = flowT;
    flowMat.uniforms.uRun.value = lerp(flowMat.uniforms.uRun.value, op.power, Math.min(1, dt * 3));

    emitParticles(dt, P, atm);
    smoke.update(dt);
    sparks.update(dt);
    env.update(op.alt, dt, camera);

    // 环境
    const fogK = atm;
    scene.fog.color.setRGB(lerp(0.008, 0.07, fogK), lerp(0.01, 0.085, fogK), lerp(0.02, 0.13, fogK));
    scene.fog.near = curH * 7;
    scene.fog.far = curH * (32 + (1 - fogK) * 600);
    sky.material.uniforms.uAtm.value = atm;
    stars.material.opacity = clamp(1 - atm * 2.2, 0, 1) * 0.9;
    sky.position.copy(camera.position);
    stars.position.copy(camera.position);
    bloom.strength = 0.6 + op.power * 0.35;

    updateCamera(dt);
    updateLabels();
    renderShimmer(t, atm);
    composer.render();
    audio.update(op.power * (0.6 + 0.4 * op.thr), atm, pump);

    if (Math.floor(t * 4) !== Math.floor((t - dt) * 4)) drawChart();
    requestAnimationFrame(frame);
}

/* =========================================================
   启动
   ========================================================= */
function init() {
    bindUi();
    syncDesignUi();
    updateStaticPerf();
    buildEngine(design);
    curH = ev.height;
    applyViewOffset();
    const g = viewGoal('overview', curH);
    camera.position.copy(g.pos);
    controls.target.copy(g.target);
    requestAnimationFrame(frame);
    requestAnimationFrame(() => {
        // 首帧后几何已构建，按真实尺寸重新取景
        curH = geo.height;
        applyViewOffset();
        const g2 = viewGoal('overview', curH);
        // 入场：从远处高空环绕推近
        const start = g2.pos.clone().sub(g2.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.9).multiplyScalar(3.2).add(g2.target);
        start.y += curH * 2.5;
        camera.position.copy(start);
        controls.target.copy(g2.target);
        camTrans = { fromPos: start, fromT: g2.target.clone(), to: g2, t: 0, dur: reduceMotion ? 0.01 : 3.2 };
        controls.enabled = false;
    });
    setTimeout(() => {
        $('loader').classList.add('done');
        $('hud').classList.add('ready');
        drawChart();
    }, 250);
}

try {
    init();
} catch (err) {
    console.error(err);
    $('loaderText').textContent = '初始化失败：' + err.message;
}
