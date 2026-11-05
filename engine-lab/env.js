import * as THREE from 'three';

/* =========================================================
   试车环境：地面试车台（导流槽 + 钢架）、箭体尾段、高空地球
   ========================================================= */

function concreteTexture(soot = false) {
    const S = 512;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = soot ? '#2e2c2a' : '#5b5a57';
    g.fillRect(0, 0, S, S);
    const img = g.getImageData(0, 0, S, S);
    const d = img.data;
    let seed = soot ? 91 : 13;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < d.length; i += 4) {
        const n = (rnd() - 0.5) * (soot ? 26 : 34);
        d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    // 污渍
    for (let i = 0; i < 40; i++) {
        const x = rnd() * S, y = rnd() * S, r = 20 + rnd() * 90;
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, soot ? 'rgba(10,8,6,0.35)' : 'rgba(60,58,54,0.18)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr;
        g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // 伸缩缝
    g.strokeStyle = soot ? 'rgba(0,0,0,0.5)' : 'rgba(40,40,38,0.55)';
    g.lineWidth = 2;
    g.strokeRect(1, 1, S - 2, S - 2);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
}

const texConcrete = concreteTexture(false);
const texSoot = concreteTexture(true);

const M = {
    ground: new THREE.MeshStandardMaterial({ map: texConcrete, roughness: 0.92, metalness: 0 }),
    pit: new THREE.MeshStandardMaterial({ map: texSoot, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }),
    steel: new THREE.MeshStandardMaterial({ color: 0x55606e, roughness: 0.55, metalness: 0.7 }),
    rail: new THREE.MeshStandardMaterial({ color: 0xd6a632, roughness: 0.5, metalness: 0.3 }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xfff1d6 }),
    skirt: new THREE.MeshStandardMaterial({ color: 0xc3c9d1, roughness: 0.28, metalness: 1, side: THREE.DoubleSide }),
    shield: new THREE.MeshStandardMaterial({ color: 0x1d2127, roughness: 0.7, metalness: 0.4 }),
};

const beam0 = (d) => Math.max(0.3, d.rc * 0.5);

export class Environment {
    constructor(scene) {
        this.scene = scene;
        this.stand = new THREE.Group();     // 地面试车台（随高度下沉消失）
        this.skirt = new THREE.Group();     // 箭体尾段（高空时滑入）
        this.earth = this.buildEarth();
        scene.add(this.stand, this.skirt, this.earth);
        this.skirtK = 0;
        this.emit = { mouth: new THREE.Vector3(), outlet: new THREE.Vector3(), dir: new THREE.Vector3(1, 0, 0) };
    }

    clear(g) {
        g.traverse((o) => o.geometry?.dispose());
        g.clear();
    }

    /* d: { H, yExit, re, rc, plateY } */
    build(d) {
        this.d = d;
        this.clear(this.stand);
        this.clear(this.skirt);
        const De = d.re * 2;
        const gy = d.yExit - Math.max(d.re * 1.3, 0.6);      // 地面高度
        const W = Math.max(De * 1.5, 2.2);                    // 导流槽宽度（z 向）
        const x0 = -Math.max(De * 0.9, 1.4);                  // 槽口起点
        const L = Math.max(De * 7, 12);                       // 导流槽长度（+x 向）
        const D = Math.max(De * 1.6, 3);                      // 深度
        this.gy = gy;

        // 导流槽朝 -x 方向延伸（远离默认镜头），试车架立在 -z 一侧
        const trench = new THREE.Group();
        trench.rotation.y = Math.PI;
        const gantry = new THREE.Group();
        gantry.rotation.y = -Math.PI / 2;
        this.stand.add(trench, gantry);

        // 地面（带槽口）
        const size = Math.max(d.H * 40, 120);
        const shape = new THREE.Shape();
        shape.moveTo(-size, -size); shape.lineTo(size, -size); shape.lineTo(size, size); shape.lineTo(-size, size); shape.closePath();
        const hole = new THREE.Path();
        hole.moveTo(x0, -W / 2); hole.lineTo(x0 + L, -W / 2); hole.lineTo(x0 + L, W / 2); hole.lineTo(x0, W / 2); hole.closePath();
        shape.holes.push(hole);
        const gGeo = new THREE.ShapeGeometry(shape);
        gGeo.rotateX(-Math.PI / 2);
        const ground = new THREE.Mesh(gGeo, M.ground);
        ground.position.y = gy;
        // ShapeGeometry 的 uv 即平面坐标（米），每 6 米一块混凝土板
        texConcrete.repeat.set(1 / 10, 1 / 10);
        trench.add(ground);

        // 槽壁
        const wall = (w, h, x, y, z, ry) => {
            const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), M.pit);
            m.position.set(x, y, z); m.rotation.y = ry;
            trench.add(m);
        };
        wall(L, D, x0 + L / 2, gy - D / 2, -W / 2, 0);
        wall(L, D, x0 + L / 2, gy - D / 2, W / 2, Math.PI);
        wall(W, D, x0, gy - D / 2, 0, Math.PI / 2);
        texSoot.repeat.set(3, 1);
        // 槽底
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(L, W), M.pit);
        floor.rotation.x = -Math.PI / 2; floor.position.set(x0 + L / 2, gy - D, 0);
        trench.add(floor);
        // 导流斜面：把燃气偏转到 +x 方向
        const ax = x0, ay = gy - D * 0.08, bx = x0 + De * 2.2 + 1, by = gy - D;
        const rg = new THREE.BufferGeometry();
        rg.setAttribute('position', new THREE.Float32BufferAttribute([
            ax, ay, -W / 2, ax, ay, W / 2, bx, by, -W / 2, bx, by, W / 2,
        ], 3));
        rg.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0, 1, 1], 2));
        rg.setIndex([0, 1, 2, 2, 1, 3]);
        rg.computeVertexNormals();
        trench.add(new THREE.Mesh(rg, M.pit));
        // 槽口护栏
        for (const s of [1]) {
            const r = new THREE.Mesh(new THREE.BoxGeometry(L, 0.08, 0.08), M.rail);
            r.position.set(x0 + L / 2, gy + 1.0, s * (W / 2 + 0.3));
            trench.add(r);
            for (let k = 0; k <= 8; k++) {
                const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.06), M.rail);
                post.position.set(x0 + (L * k) / 8, gy + 0.5, s * (W / 2 + 0.3));
                trench.add(post);
            }
        }

        // 钢结构试车架：背侧两根立柱 + 悬臂梁吊挂发动机（不遮挡前方视线）
        const S = Math.max(d.rc * 3.2, d.re * 1.35, 1.2);
        const topY = d.plateY + Math.max(d.rc * 1.2, 0.6);
        const colH = topY - gy + beam0(d);
        const beam = Math.max(0.16, S * 0.08);
        const cx = -S * 1.15;
        for (const sz of [-1, 1]) {
            const col = new THREE.Mesh(new THREE.BoxGeometry(beam * 1.4, colH, beam * 1.4), M.steel);
            col.position.set(cx, gy + colH / 2, sz * S * 0.9);
            gantry.add(col);
            // 悬臂
            const arm = new THREE.Mesh(new THREE.BoxGeometry(-cx + beam, beam, beam), M.steel);
            arm.position.set(cx / 2, topY, sz * S * 0.35);
            gantry.add(arm);
            // 斜撑
            const br = new THREE.Mesh(new THREE.BoxGeometry(beam * 0.5, Math.hypot(-cx * 0.8, colH * 0.3), beam * 0.5), M.steel);
            br.position.set(cx * 0.6, topY - colH * 0.15, sz * S * 0.35);
            br.rotation.z = Math.atan2(-cx * 0.8, colH * 0.3);
            gantry.add(br);
        }
        // 立柱之间的 X 形支撑
        for (const s of [-1, 1]) {
            const xb = new THREE.Mesh(new THREE.BoxGeometry(beam * 0.45, Math.hypot(S * 1.8, colH * 0.8), beam * 0.45), M.steel);
            xb.position.set(cx, gy + colH * 0.45, 0);
            xb.rotation.x = s * Math.atan2(S * 1.8, colH * 0.8);
            gantry.add(xb);
        }
        const tb = new THREE.Mesh(new THREE.BoxGeometry(beam, beam, S * 1.8 + beam * 1.4), M.steel);
        tb.position.set(cx, topY, 0);
        gantry.add(tb);
        const hanger = new THREE.Mesh(new THREE.BoxGeometry(beam * 1.2, topY - d.plateY, S * 0.9), M.steel);
        hanger.position.set(0, (topY + d.plateY) / 2, 0);
        gantry.add(hanger);
        // 照明灯杆
        for (const [lx, lz] of [[-S * 5, S * 3], [S * 2, -S * 5]]) {
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, colH * 1.6, 8), M.steel);
            pole.position.set(lx, gy + colH * 0.8, lz);
            const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.35, 0.5), M.lamp);
            head.position.set(lx, gy + colH * 1.6, lz);
            this.stand.add(pole, head);
        }

        // 粒子发射点
        this.emit.mouth.set(-(x0 + De * 0.9), gy + 0.2, 0);
        this.emit.outlet.set(-(x0 + L), gy - D * 0.4, 0);
        this.emit.dir.set(-1, 0, 0);
        this.emit.width = W;
        this.emit.depth = D;

        // 箭体尾段（不锈钢筒段 + 隔热底板）
        const Rs = Math.max(d.rc * 2.6, d.re * 1.15, 0.8);
        const hS = Math.max(d.H * 0.9, 2.5);
        const shell = new THREE.Mesh(new THREE.CylinderGeometry(Rs, Rs, hS, 96, 1, true), M.skirt);
        shell.position.y = d.plateY + hS / 2 + 0.05;
        const shield = new THREE.Mesh(new THREE.CylinderGeometry(Rs * 1.002, Rs * 1.002, Math.max(0.08, d.rc * 0.18), 96), M.shield);
        shield.position.y = d.plateY + 0.05;
        // 焊缝环
        const seams = [];
        for (let k = 1; k < 4; k++) {
            const ring = new THREE.Mesh(new THREE.TorusGeometry(Rs * 1.001, 0.012 * Rs, 4, 96), M.steel);
            ring.rotation.x = Math.PI / 2; ring.position.y = d.plateY + (hS * k) / 4;
            seams.push(ring);
        }
        this.skirt.add(shell, shield, ...seams);
        this.skirtH = hS;
    }

    buildEarth() {
        const mat = new THREE.ShaderMaterial({
            uniforms: { uOpacity: { value: 0 }, uSun: { value: new THREE.Vector3(0.4, 0.6, 0.5).normalize() } },
            vertexShader: /* glsl */`
                varying vec3 vN; varying vec3 vW; varying vec3 vP;
                void main(){
                    vP = position;
                    vN = normalize(mat3(modelMatrix) * normal);
                    vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
                    gl_Position = projectionMatrix * viewMatrix * w;
                }`,
            fragmentShader: /* glsl */`
                uniform float uOpacity; uniform vec3 uSun;
                varying vec3 vN; varying vec3 vW; varying vec3 vP;
                float h(vec3 p){ p = fract(p * 0.3183 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
                float n3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
                    return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),
                               mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
                float fbm(vec3 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * n3(p); p *= 2.1; a *= 0.5; } return s; }
                void main(){
                    vec3 N = normalize(vN);
                    vec3 V = normalize(cameraPosition - vW);
                    vec3 q = normalize(vP) * 6.0;
                    float land = smoothstep(0.52, 0.56, fbm(q));
                    float cloud = smoothstep(0.5, 0.75, fbm(q * 2.3 + 7.0));
                    vec3 col = mix(vec3(0.02, 0.07, 0.16), vec3(0.12, 0.13, 0.08), land);
                    col = mix(col, vec3(0.85, 0.88, 0.92), cloud * 0.85);
                    float lit = max(dot(N, uSun), 0.0) * 0.9 + 0.1;
                    col *= lit;
                    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
                    col += vec3(0.25, 0.5, 1.0) * rim * 1.2;
                    gl_FragColor = vec4(col, uOpacity);
                }`,
            transparent: true, depthWrite: false,
        });
        const m = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), mat);
        m.renderOrder = -1;
        m.visible = false;
        return m;
    }

    /* alt: km, H: 发动机特征尺寸 */
    update(alt, dt, camera) {
        const d = this.d;
        if (!d) return;
        // 地面试车台随高度下沉，雾中淡出
        const sink = alt * Math.max(d.H, 2) * 6;
        this.stand.position.y = -sink;
        this.stand.visible = alt < 6;
        // 尾段：离开地面后从上方滑入
        const want = alt > 0.6 ? 1 : 0;
        this.skirtK += (want - this.skirtK) * Math.min(1, dt * 2.2);
        this.skirt.visible = this.skirtK > 0.005;
        this.skirt.position.y = (1 - this.skirtK) * this.skirtH * 1.8;
        // 地球：25 km 以上逐渐出现
        const k = THREE.MathUtils.smoothstep(alt, 18, 45);
        this.earth.visible = k > 0.001;
        if (this.earth.visible) {
            const Re = Math.max(d.H, 2) * 900;
            const drop = Math.max(d.H, 2) * (25 + alt * 0.9);
            this.earth.scale.setScalar(Re);
            this.earth.position.set(camera.position.x * 0.0, -Re - drop, 0);
            this.earth.material.uniforms.uOpacity.value = k;
        }
    }
}
