import * as THREE from 'three';

/* =========================================================
   GPU 公告板粒子（CPU 积分 + 实例化渲染）
   用于：导流槽水汽烟云、预冷白雾、冰屑、点火火花
   ========================================================= */

function puffTexture() {
    const S = 128;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 26; i++) {
        const a = rnd() * Math.PI * 2, r = rnd() * S * 0.2;
        const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r;
        const rad = S * (0.16 + rnd() * 0.18);
        const gr = g.createRadialGradient(x, y, 0, x, y, rad);
        gr.addColorStop(0, 'rgba(255,255,255,0.22)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(0, 0, S, S);
    }
    return new THREE.CanvasTexture(c);
}

function dotTexture() {
    const S = 64;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.25, 'rgba(255,255,255,0.6)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
    return new THREE.CanvasTexture(c);
}

const VS = /* glsl */`
    attribute vec3 aPos; attribute vec4 aData; attribute vec3 aCol;
    uniform vec3 uLightPos; uniform float uLightI, uFalloff;
    varying vec2 vUv; varying float vAlpha; varying vec3 vCol; varying float vHeat; varying float vLit;
    void main(){
        float c = cos(aData.z), s = sin(aData.z);
        vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * aData.x;
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 w = aPos + right * q.x + up * q.y;
        vUv = uv; vAlpha = aData.y; vCol = aCol; vHeat = aData.w;
        float d = distance(aPos, uLightPos);
        vLit = uLightI / (1.0 + d * d * uFalloff);
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
    }`;

const FS = /* glsl */`
    uniform sampler2D uMap; uniform vec3 uLightCol, uAmb; uniform float uAdd;
    varying vec2 vUv; varying float vAlpha; varying vec3 vCol; varying float vHeat; varying float vLit;
    void main(){
        vec4 t = texture2D(uMap, vUv);
        float a = t.a * vAlpha;
        if (a < 0.002) discard;
        if (uAdd > 0.5) {
            gl_FragColor = vec4(vCol * a * 2.5, a);
            return;
        }
        float shade = 0.55 + 0.45 * vUv.y;
        vec3 c = vCol * (uAmb * shade + uLightCol * vLit) + vec3(1.0, 0.5, 0.2) * vHeat * 1.6;
        gl_FragColor = vec4(c, a);
    }`;

export class Particles {
    constructor(max, { additive = false } = {}) {
        this.max = max;
        this.n = 0;
        const base = new THREE.PlaneGeometry(1, 1);
        const g = new THREE.InstancedBufferGeometry();
        g.index = base.index;
        g.setAttribute('position', base.getAttribute('position'));
        g.setAttribute('uv', base.getAttribute('uv'));
        const mk = (k) => new THREE.InstancedBufferAttribute(new Float32Array(max * k), k).setUsage(THREE.DynamicDrawUsage);
        this.aPos = mk(3); this.aData = mk(4); this.aCol = mk(3);
        g.setAttribute('aPos', this.aPos);
        g.setAttribute('aData', this.aData);
        g.setAttribute('aCol', this.aCol);
        g.instanceCount = 0;
        this.uniforms = {
            uMap: { value: additive ? dotTexture() : puffTexture() },
            uLightPos: { value: new THREE.Vector3() }, uLightI: { value: 0 }, uFalloff: { value: 0.05 },
            uLightCol: { value: new THREE.Color(1, 1, 1) }, uAmb: { value: new THREE.Color(0.6, 0.65, 0.72) },
            uAdd: { value: additive ? 1 : 0 },
        };
        this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
            uniforms: this.uniforms, vertexShader: VS, fragmentShader: FS,
            transparent: true, depthWrite: false,
            blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        }));
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = additive ? 4 : 3;
        // CPU 状态
        const f = (k = 1) => new Float32Array(max * k);
        this.p = f(3); this.v = f(3); this.col = f(3);
        this.age = f(); this.life = f(); this.s0 = f(); this.s1 = f(); this.a0 = f();
        this.rot = f(); this.rotV = f(); this.heat = f(); this.drag = f(); this.buoy = f();
    }

    spawn(o) {
        let i = this.n;
        if (i >= this.max) {
            // 满了就替换最老的一个
            let oldest = 0, best = -1;
            for (let k = 0; k < this.max; k++) { const r = this.age[k] / this.life[k]; if (r > best) { best = r; oldest = k; } }
            i = oldest;
        } else this.n++;
        this.p.set(o.p, i * 3);
        this.v.set(o.v, i * 3);
        this.col.set(o.col || [1, 1, 1], i * 3);
        this.age[i] = 0;
        this.life[i] = o.life;
        this.s0[i] = o.s0; this.s1[i] = o.s1 ?? o.s0;
        this.a0[i] = o.a ?? 1;
        this.rot[i] = Math.random() * Math.PI * 2;
        this.rotV[i] = o.rotV ?? (Math.random() - 0.5) * 0.6;
        this.heat[i] = o.heat ?? 0;
        this.drag[i] = o.drag ?? 0.5;
        this.buoy[i] = o.buoy ?? 0;
    }

    clear() { this.n = 0; this.mesh.geometry.instanceCount = 0; }

    update(dt) {
        const { p, v } = this;
        let i = 0;
        while (i < this.n) {
            this.age[i] += dt;
            if (this.age[i] >= this.life[i]) {
                const j = --this.n;
                if (i !== j) this.copy(j, i);
                continue;
            }
            const k = Math.exp(-this.drag[i] * dt);
            v[i * 3] *= k; v[i * 3 + 1] = v[i * 3 + 1] * k + this.buoy[i] * dt; v[i * 3 + 2] *= k;
            p[i * 3] += v[i * 3] * dt; p[i * 3 + 1] += v[i * 3 + 1] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt;
            this.rot[i] += this.rotV[i] * dt;
            const t = this.age[i] / this.life[i];
            const size = this.s0[i] + (this.s1[i] - this.s0[i]) * (1 - (1 - t) * (1 - t));
            const alpha = this.a0[i] * Math.min(1, t / 0.06) * Math.pow(1 - t, 1.4);
            this.aPos.array[i * 3] = p[i * 3]; this.aPos.array[i * 3 + 1] = p[i * 3 + 1]; this.aPos.array[i * 3 + 2] = p[i * 3 + 2];
            this.aData.array[i * 4] = size;
            this.aData.array[i * 4 + 1] = alpha;
            this.aData.array[i * 4 + 2] = this.rot[i];
            this.aData.array[i * 4 + 3] = this.heat[i] * Math.exp(-this.age[i] * 3);
            this.aCol.array[i * 3] = this.col[i * 3]; this.aCol.array[i * 3 + 1] = this.col[i * 3 + 1]; this.aCol.array[i * 3 + 2] = this.col[i * 3 + 2];
            i++;
        }
        const g = this.mesh.geometry;
        g.instanceCount = this.n;
        this.aPos.needsUpdate = this.aData.needsUpdate = this.aCol.needsUpdate = true;
    }

    copy(from, to) {
        for (let k = 0; k < 3; k++) {
            this.p[to * 3 + k] = this.p[from * 3 + k];
            this.v[to * 3 + k] = this.v[from * 3 + k];
            this.col[to * 3 + k] = this.col[from * 3 + k];
        }
        for (const key of ['age', 'life', 's0', 's1', 'a0', 'rot', 'rotV', 'heat', 'drag', 'buoy']) this[key][to] = this[key][from];
    }
}
