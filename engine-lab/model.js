/* =========================================================
   推进器性能模型（理想火箭理论 + 经验修正）
   单位：压力 Pa，长度 m，质量 kg，力 N
   ========================================================= */

export const G0 = 9.80665;
const RU = 8314.46;

/* 推进剂：最佳混合比附近的燃烧温度 Tc、燃气平均分子量 M、比热比 γ */
export const PROPELLANTS = {
    methalox: {
        name: '甲烷 / 液氧', short: 'CH₄/LOX',
        of: [2.6, 4.2], ofOpt: 3.6, Tc: 3620, M: 21.6, g: 1.17,
        cycles: ['gg', 'staged', 'ffsc', 'expander'],
    },
    hydrolox: {
        name: '液氢 / 液氧', short: 'LH₂/LOX',
        of: [4.0, 7.0], ofOpt: 6.0, Tc: 3480, M: 13.4, g: 1.17,
        cycles: ['gg', 'staged', 'ffsc', 'expander'],
    },
    kerolox: {
        name: '煤油 / 液氧', short: 'RP-1/LOX',
        of: [2.0, 3.0], ofOpt: 2.6, Tc: 3670, M: 23.3, g: 1.18,
        cycles: ['gg', 'staged'],
    },
    ntr: {
        name: '核热 · 液氢', short: 'NTR/H₂',
        of: null, Tc: 2750, M: 2.2, g: 1.34,
        cycles: ['expander'],
    },
};

/* 动力循环：Isp 修正、可承受的最高室压、相对结构质量 */
export const CYCLES = {
    gg: { name: '燃气发生器', short: 'GG', eta: 0.962, pcMax: 12, massMul: 1.12 },
    staged: { name: '分级燃烧', short: 'SC', eta: 0.988, pcMax: 27, massMul: 0.98 },
    ffsc: { name: '全流量分级', short: 'FFSC', eta: 0.992, pcMax: 35, massMul: 1.0 },
    expander: { name: '膨胀循环', short: 'EXP', eta: 0.99, pcMax: 8, massMul: 0.9 },
};

export const PRESETS = {
    sea: {
        name: '海平面主机', prop: 'methalox', cycle: 'ffsc',
        pc: 28, of: 3.6, dt: 0.24, eps: 34, bell: 0.8,
    },
    vac: {
        name: '真空型', prop: 'methalox', cycle: 'ffsc',
        pc: 28, of: 3.6, dt: 0.24, eps: 90, bell: 0.85,
    },
    upper: {
        name: '氢氧上面级', prop: 'hydrolox', cycle: 'expander',
        pc: 6, of: 5.8, dt: 0.13, eps: 110, bell: 0.9,
    },
    nuclear: {
        name: '核热深空', prop: 'ntr', cycle: 'expander',
        pc: 7, of: 0, dt: 0.2, eps: 150, bell: 0.9,
    },
};

/* 混合比对燃烧温度、分子量的影响（偏富燃时分子量更低） */
export function thermo(prop, of) {
    const p = PROPELLANTS[prop];
    if (!p.of) return { Tc: p.Tc, M: p.M, g: p.g };
    const x = of / p.ofOpt - 1;
    const Tc = p.Tc * (1 - 0.55 * x * x - (x < 0 ? 0.32 * -x : 0));
    const M = p.M * (1 + 0.42 * x);
    const g = p.g + (x < 0 ? -0.04 * x : 0.01 * x);
    return { Tc, M, g };
}

/* 面积比 → 马赫数（supersonic: 超声速分支） */
export function areaRatio(M, g) {
    return (1 / M) * Math.pow((2 / (g + 1)) * (1 + (g - 1) / 2 * M * M), (g + 1) / (2 * (g - 1)));
}
export function machFromArea(eps, g, supersonic = true) {
    if (eps <= 1) return 1;
    let lo = supersonic ? 1 : 1e-4, hi = supersonic ? 30 : 1;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        const a = areaRatio(mid, g);
        if (supersonic ? a < eps : a > eps) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

/* 标准大气压（简化指数模型），100 km 视作真空 */
export function ambient(hKm) {
    if (hKm >= 99.9) return 0;
    return 101325 * Math.exp(-hKm / 7.4);
}

/* 钟形喷管长度系数 → 扩张损失系数 λ */
export function divergence(bell) {
    return 0.992 - 0.09 * (1 - bell) * (1 - bell);
}

/* 喷管型面（Rao 抛物线近似），返回 [{z, r}]，z 向下为负 */
export function contour(d, n = 64) {
    const rt = d.dt / 2;
    const re = rt * Math.sqrt(d.eps);
    const rc = rt * 1.95;                       // 燃烧室半径（收缩比约 3.8）
    const lc = rt * 3.4;                        // 燃烧室圆柱段长度
    const conv = (rc - rt) / Math.tan(30 * Math.PI / 180) * 0.9;
    const cone15 = (re - rt) / Math.tan(15 * Math.PI / 180);
    const ln = cone15 * d.bell;                 // 扩张段长度
    const thN = Math.min(36, 21 + d.eps * 0.12) * Math.PI / 180;
    const thE = Math.max(3, 13 - d.eps * 0.045 - (1 - d.bell) * 8) * Math.PI / 180;
    const pts = [];
    const z0 = 0;
    // 喷注器面到燃烧室
    pts.push({ z: z0, r: rc * 0.94, part: 'inj' });
    pts.push({ z: z0 - rt * 0.15, r: rc, part: 'ch' });
    pts.push({ z: z0 - lc, r: rc, part: 'ch' });
    // 收敛段（余弦过渡）
    const zt = z0 - lc - conv;
    for (let i = 1; i <= 14; i++) {
        const t = i / 14;
        const r = rt + (rc - rt) * (0.5 + 0.5 * Math.cos(Math.PI * t));
        pts.push({ z: z0 - lc - conv * t, r, part: 'conv' });
    }
    // 扩张段：二次贝塞尔，起始角 thN，出口角 thE
    const P0 = { z: 0, r: rt };
    const P2 = { z: ln, r: re };
    // 两切线交点
    const m1 = Math.tan(thN), m2 = Math.tan(thE);
    let qz = (re - m2 * ln - rt) / (m1 - m2);
    qz = Math.min(Math.max(qz, ln * 0.05), ln * 0.95);
    const P1 = { z: qz, r: rt + m1 * qz };
    for (let i = 1; i <= n; i++) {
        const t = i / n;
        const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
        const z = a * P0.z + b * P1.z + c * P2.z;
        const r = a * P0.r + b * P1.r + c * P2.r;
        pts.push({ z: zt - z, r, part: 'div' });
    }
    return { pts, rt, re, rc, lc, zt, ln, length: lc + conv + ln };
}

/* 核心：在给定环境压力与节流下计算性能 */
export function perf(d, pa, throttle = 1) {
    const { Tc, M, g } = thermo(d.prop, d.of);
    const cyc = CYCLES[d.cycle];
    const R = RU / M;
    const pc = d.pc * 1e6 * throttle;
    const At = Math.PI * (d.dt / 2) ** 2;
    const Ae = At * d.eps;
    const Me = machFromArea(d.eps, g);
    const pr = Math.pow(1 + (g - 1) / 2 * Me * Me, -g / (g - 1));
    const pe = pc * pr;
    const gam = Math.sqrt(g) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));
    const cstar = Math.sqrt(R * Tc) / gam * 0.985;   // 含燃烧效率
    const mdot = pc * At / cstar;
    const ve = Math.sqrt(2 * g / (g - 1) * R * Tc * (1 - Math.pow(pr, (g - 1) / g)));
    const lam = divergence(d.bell);
    const mom = mdot * ve * lam * cyc.eta;
    // 流动分离（Summerfield 判据 pe < 0.4 pa）：分离后压力项不再继续恶化
    const sepLimit = 0.4 * pa;
    const separated = pa > 0 && pe < sepLimit;
    const pTerm = separated ? (sepLimit - pa) * Ae * 0.55 : (pe - pa) * Ae;
    const F = Math.max(0, mom + pTerm);
    const Isp = F / (mdot * G0);
    const Te = Tc * Math.pow(pr, (g - 1) / g);
    return { Tc, M, g, pc, At, Ae, Me, pe, pa, cstar, mdot, ve, F, Isp, Te, separated, lam };
}

/* 设计整体评估 */
export function evaluate(d) {
    const c = contour(d);
    const sl = perf(d, ambient(0));
    const vac = perf(d, 0);
    const cyc = CYCLES[d.cycle];
    // 发动机质量：主体随真空推力，核热反应堆极重；外加喷管延伸段
    const twBase = d.prop === 'ntr' ? 5 : 175;
    const core = vac.F / (G0 * twBase) * cyc.massMul * (0.85 + 0.15 * d.pc / 20);
    const nozzleArea = Math.PI * (c.rt + c.re) * Math.hypot(c.ln, c.re - c.rt);
    const nozzle = nozzleArea * 22;
    const mass = core + nozzle;
    const load = d.pc / cyc.pcMax;
    // 热流 ∝ pc^0.8 · Tc，转化为冷却裕度
    const heat = Math.pow(d.pc / 20, 0.8) * (sl.Tc / 3500) * (d.prop === 'hydrolox' || d.prop === 'ntr' ? 0.78 : 1);
    const coolMargin = 1.55 / heat - 1;
    // 理想膨胀高度：pe = pa
    const hIdeal = vac.pe >= 101325 ? 0 : -7.4 * Math.log(vac.pe / 101325);
    return {
        c, sl, vac, mass, load, coolMargin, hIdeal,
        twSL: sl.F / (mass * G0), twVac: vac.F / (mass * G0),
        height: c.length + c.rc * 1.7,
    };
}
