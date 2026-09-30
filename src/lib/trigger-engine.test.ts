// 圖上拖曳改價與平倉撤保護單。改動一律經由執行視窗的指令匯流排；
// 券商 I/O 全部 mock，不會送出任何委託。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';

const F1: Account = { account_type: 'F', broker_id: 'fixture-broker-F', account_id: 'fixture-account-F',
    person_id: '', signed: true, username: '' };
const FUT = (code: string) => ({ code, security_type: 'FUT', exchange: 'TAIFEX' });
const SIM = 'http://sim.invalid|simulation';

const m = vi.hoisted(() => ({ store: new Map<string, string>(), notify: vi.fn() }));

vi.mock('./runtime', () => ({ getApiBase: () => 'http://sim.invalid' }));
vi.mock('./stream', () => ({
    getStreamStatus: () => 'live',
    subscribeStatusStore: () => () => undefined,
    onOrderEvent: () => () => undefined,
    onAnyTick: () => () => undefined,
    onOddLotTick: () => () => undefined,
    onStreamEvent: () => () => undefined,
}));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: [F1], selectedStock: null, selectedFutures: F1 }) }));
vi.mock('./trade', () => ({ notify: m.notify, placeQuickOrder: vi.fn() }));
vi.mock('./contracts-cache', () => ({ ensureContract: async (code: string) => FUT(code), getCachedContract: () => undefined }));
vi.mock('./quote-ownership', () => ({ retainQuote: () => () => undefined }));
vi.mock('./trading-state', () => ({ getTradingState: () => ({ positions: [],
    queries: { positions: { updatedAt: null, needsReconcile: false, error: null } } }) }));
vi.mock('./shioaji', () => ({ fetchTrades: async () => [] }));
vi.mock('./protection-env', () => ({
    currentProtectionEnv: () => SIM,
    refreshProtectionEnv: async () => undefined,
    onProtectionEnvChange: () => () => undefined,
    envBase: (env: string) => env.slice(0, env.lastIndexOf('|')),
    reportEnvMatches: () => true,
    watchProtectionEnv: () => undefined,
}));

let engine: typeof import('./trigger-engine');
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); }

beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.resetModules();
    m.store.clear();
    m.notify.mockReset();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.store.get(k) ?? null, setItem: (k: string, v: string) => { m.store.set(k, v); } });
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('navigator', { locks: { request: (_n: string, a: unknown, b?: (lock: object | null) => unknown) => {
        const cb = (typeof a === 'function' ? a : b) as (lock: object | null) => unknown;
        if (typeof a === 'function' || !(a as { ifAvailable?: boolean }).ifAvailable) return new Promise(() => undefined);
        const r = cb({}); return Promise.resolve(r instanceof Promise ? undefined : r); } } });
    engine = await import('./trigger-engine');
    engine.startTriggerEngine();
    await flush();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const add = async (over: Partial<import('./trigger-engine').NewTrigger> = {}) => {
    const code = over.code ?? 'TXFI6';
    const t = await engine.addTrigger({ code, condition: 'below', price: 23000, action: 'Sell', quantity: 1, kind: 'stop', ...over },
        FUT(code) as never);
    return t!;
};

describe('拖曳改價', () => {
    it('只改價，condition 與數量原封不動', async () => {
        const t = await add();
        const after = await engine.updateTriggerPrice(t.id, 22900);
        expect(after).toMatchObject({ price: 22900, condition: 'below', action: 'Sell', quantity: 1, kind: 'stop' });
        expect(engine.getTriggers()[0]!.price).toBe(22900);
    });

    it('寫回 localStorage — 重開 App 後還在新價位', async () => {
        const t = await add();
        await engine.updateTriggerPrice(t.id, 22800);
        expect(JSON.parse(m.store.get('sj-pro-triggers')!)[0].price).toBe(22800);
    });

    it('改不存在的單回 null，不會憑空長出一筆', async () => {
        expect(await engine.updateTriggerPrice('nope', 100)).toBeNull();
        expect(engine.getTriggers()).toHaveLength(0);
    });

    it('只動指定的那一筆', async () => {
        const a = await add();
        const b = await add();
        await engine.updateTriggerPrice(a.id, 22000);
        expect(engine.getTriggers().find((t) => t.id === b.id)!.price).toBe(23000);
    });
});

describe('「放手就觸發」的判斷', () => {
    it('below 在現價之上就會立刻觸發', () => {
        expect(engine.wouldFireAt('below', 23100, 23050)).toBe(true);
        expect(engine.wouldFireAt('below', 22900, 23050)).toBe(false);
    });

    it('above 在現價之下就會立刻觸發', () => {
        expect(engine.wouldFireAt('above', 23000, 23050)).toBe(true);
        expect(engine.wouldFireAt('above', 23100, 23050)).toBe(false);
    });

    it('剛好等於現價算觸發 — 引擎用的是 <= / >=，兩邊要一致', () => {
        expect(engine.wouldFireAt('below', 23050, 23050)).toBe(true);
        expect(engine.wouldFireAt('above', 23050, 23050)).toBe(true);
    });
});

describe('平倉後撤掉保護單', () => {
    it('撤掉停損與停利 — 部位沒了還留著會開出反向新倉', async () => {
        await add({ kind: 'stop' });
        await add({ kind: 'take', condition: 'above', price: 23500 });
        expect(await engine.cancelProtectiveTriggers(['TXFI6'])).toHaveLength(2);
        expect(engine.getTriggers()).toHaveLength(0);
    });

    it('警示留著 — 那只是通知，不會送單', async () => {
        await add({ kind: 'alert' });
        await add({ kind: 'stop' });
        await engine.cancelProtectiveTriggers(['TXFI6']);
        expect(engine.getTriggers().map((t) => t.kind)).toEqual(['alert']);
    });

    it('不碰其他商品的保護單', async () => {
        await add({ code: 'TXFI6' });
        await add({ code: 'MXFI6' });
        await engine.cancelProtectiveTriggers(['TXFI6']);
        expect(engine.getTriggers().map((t) => t.code)).toEqual(['MXFI6']);
    });

    it('一次收多個代碼 — 連續月別名與月份合約指同一個部位', async () => {
        await add({ code: 'TXFR1' });
        await add({ code: 'TXFI6' });
        expect(await engine.cancelProtectiveTriggers(['TXFI6', 'TXFR1', ''])).toHaveLength(2);
        expect(engine.getTriggers()).toHaveLength(0);
    });
});
