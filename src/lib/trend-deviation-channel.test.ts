import { describe, expect, it } from 'vitest';
import { trendDeviationChannel } from './indicators';
import type { Candle } from './types/market';

function makeBars(closes: number[]): Candle[] {
    return closes.map((c, i) => ({
        time: 1_700_000_000 + i * 60,
        open: c,
        high: c + 0.5,
        low: c - 0.5,
        close: c,
        volume: 100,
    }));
}

// deterministic small-amplitude noise so residual/deviation math sees
// non-degenerate variance (a perfectly straight line collapses ATR to 0)
function noisy(base: (i: number) => number, n: number, amp = 0.4): number[] {
    let seed = 7;
    const rnd = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    };
    return Array.from({ length: n }, (_, i) => base(i) + (rnd() - 0.5) * amp);
}

const DEFAULTS = {
    trendLen: 30,
    enterStrength: 1.0,
    exitStrength: 0.25,
    shockCap: 4,
    minWidth: 0.05,
    minSamples: 4,
    dev1: 1.0,
    dev2: 2.0,
    dev3: 3.0,
};

function run(closes: number[], symmetric = false) {
    return trendDeviationChannel(
        makeBars(closes),
        DEFAULTS.trendLen,
        DEFAULTS.enterStrength,
        DEFAULTS.exitStrength,
        symmetric,
        DEFAULTS.shockCap,
        DEFAULTS.minWidth,
        DEFAULTS.minSamples,
        DEFAULTS.dev1,
        DEFAULTS.dev2,
        DEFAULTS.dev3,
    );
}

describe('trendDeviationChannel', () => {
    it('gaps every output during warm-up (before trendLen bars exist)', () => {
        const closes = noisy((i) => 100 + i * 0.3, 20);
        const r = run(closes);
        for (const series of Object.values(r)) {
            for (const p of series) expect(p.value).toBeUndefined();
        }
    });

    it('classifies a steady uptrend as up and keeps rails ordered', () => {
        const closes = noisy((i) => 100 + i * 0.8, 120, 0.3);
        const r = run(closes);
        const last = closes.length - 1;

        expect(r.trendUp[last]!.value).toBeDefined();
        expect(r.trendDown[last]!.value).toBeUndefined();
        expect(r.trendNeutral[last]!.value).toBeUndefined();

        const center = r.trendUp[last]!.value!;
        const u1 = r.upper1[last]!.value!;
        const u2 = r.upper2[last]!.value!;
        const u3 = r.upper3[last]!.value!;
        const l1 = r.lower1[last]!.value!;
        const l2 = r.lower2[last]!.value!;
        const l3 = r.lower3[last]!.value!;
        expect(u3).toBeGreaterThan(u2);
        expect(u2).toBeGreaterThan(u1);
        expect(u1).toBeGreaterThan(center);
        expect(center).toBeGreaterThan(l1);
        expect(l1).toBeGreaterThan(l2);
        expect(l2).toBeGreaterThan(l3);
    });

    it('classifies a steady downtrend as down', () => {
        const closes = noisy((i) => 200 - i * 0.8, 120, 0.3);
        const r = run(closes);
        const last = closes.length - 1;
        expect(r.trendDown[last]!.value).toBeDefined();
        expect(r.trendUp[last]!.value).toBeUndefined();
    });

    it('stays neutral for a flat, range-bound series', () => {
        let seed = 3;
        const rnd = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        const closes = Array.from({ length: 120 }, () => 100 + (rnd() - 0.5) * 0.2);
        const r = run(closes);
        const last = closes.length - 1;
        expect(r.trendNeutral[last]!.value).toBeDefined();
        expect(r.trendUp[last]!.value).toBeUndefined();
        expect(r.trendDown[last]!.value).toBeUndefined();
    });

    it('makes symmetric upper/lower spread equal, unlike asymmetric', () => {
        // skewed noise: larger excursions on the upside only
        let seed = 11;
        const rnd = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        const closes = Array.from({ length: 120 }, (_, i) => {
            const base = 100 + i * 0.5;
            const up = rnd() * 3;
            return base + up;
        });

        const sym = run(closes, true);
        const asym = run(closes, false);
        const last = closes.length - 1;

        const symCenter = (sym.trendUp[last]?.value ?? sym.trendDown[last]?.value ?? sym.trendNeutral[last]?.value)!;
        const symSpreadUp = sym.upper1[last]!.value! - symCenter;
        const symSpreadDown = symCenter - sym.lower1[last]!.value!;
        expect(symSpreadUp).toBeCloseTo(symSpreadDown, 6);

        const asymCenter = (asym.trendUp[last]?.value ?? asym.trendDown[last]?.value ?? asym.trendNeutral[last]?.value)!;
        const asymSpreadUp = asym.upper1[last]!.value! - asymCenter;
        const asymSpreadDown = asymCenter - asym.lower1[last]!.value!;
        expect(asymSpreadUp).not.toBeCloseTo(asymSpreadDown, 3);
    });

    it('is registered in the indicator picker with the trendDeviationChannel compute path', async () => {
        const { DEF_BY_TYPE } = await import('./indicator-defs');
        const def = DEF_BY_TYPE.get('trenddevchannel');
        expect(def).toBeDefined();
        expect(def!.category).toBe('overlay');
        const closes = noisy((i) => 100 + i * 0.5, 60, 0.3);
        const out = def!.compute(makeBars(closes), {
            trendLen: 30,
            enterStrength: 1.0,
            exitStrength: 0.25,
            shape: 0,
            shockCap: 4,
            minWidth: 0.05,
            minSamples: 4,
            dev1: 1.0,
            dev2: 2.0,
            dev3: 3.0,
        });
        expect(Object.keys(out).sort()).toEqual(
            [
                'trendUp', 'trendDown', 'trendNeutral',
                'upper1', 'upper2', 'upper3',
                'lower1', 'lower2', 'lower3',
            ].sort(),
        );
    });
});
