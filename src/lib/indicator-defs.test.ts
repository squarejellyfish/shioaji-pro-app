import { describe, expect, it } from 'vitest';
import {
    DEF_BY_TYPE,
    instanceLabel,
    resolveParams,
    type IndicatorInstance,
} from './indicator-defs';

function makeInst(overrides: Partial<IndicatorInstance> = {}): IndicatorInstance {
    return {
        id: 'sma-test',
        type: 'sma',
        params: { period: 20 },
        colors: {},
        ...overrides,
    };
}

describe('resolveParams (per-timeframe param overrides)', () => {
    const def = DEF_BY_TYPE.get('sma')!;

    it('falls back to the shared params when no per-tf override exists', () => {
        const inst = makeInst();
        expect(resolveParams(inst, def, 1)).toEqual({ period: 20 });
        expect(resolveParams(inst, def, 60)).toEqual({ period: 20 });
    });

    it('uses the tf-specific override only for that timeframe', () => {
        const inst = makeInst({ paramsByTf: { 1: { period: 5 } } });
        expect(resolveParams(inst, def, 1)).toEqual({ period: 5 });
        expect(resolveParams(inst, def, 60)).toEqual({ period: 20 }); // untouched
    });

    it('supports independent overrides on multiple timeframes at once', () => {
        const inst = makeInst({
            paramsByTf: { 1: { period: 5 }, 60: { period: 50 } },
        });
        expect(resolveParams(inst, def, 1)).toEqual({ period: 5 });
        expect(resolveParams(inst, def, 60)).toEqual({ period: 50 });
        expect(resolveParams(inst, def, 1440)).toEqual({ period: 20 }); // no override — shared default
    });

    it('falls back to the definition default for a key missing from an override', () => {
        // e.g. schema grew a new param key after this override was saved
        const inst = makeInst({
            type: 'boll',
            params: { period: 20, mult: 2 },
            paramsByTf: { 1: { period: 10 } }, // "mult" missing from override
        });
        const bollDef = DEF_BY_TYPE.get('boll')!;
        expect(resolveParams(inst, bollDef, 1)).toEqual({ period: 10, mult: 2 });
    });
});

describe('instanceLabel with tfMinutes', () => {
    it('reflects the shared default when tfMinutes is omitted', () => {
        const inst = makeInst({ paramsByTf: { 1: { period: 5 } } });
        expect(instanceLabel(inst)).toBe('MA(20)');
    });

    it('reflects the resolved (possibly overridden) value for a given timeframe', () => {
        const inst = makeInst({ paramsByTf: { 1: { period: 5 } } });
        expect(instanceLabel(inst, 1)).toBe('MA(5)');
        expect(instanceLabel(inst, 60)).toBe('MA(20)');
    });
});
