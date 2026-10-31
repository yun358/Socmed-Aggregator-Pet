/** core/balance.ts: what the pet's balance bubble is told about the active endpoint. */
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreConfig } from 'cortico/core/types.ts';
import { activeBalance } from '../core/balance.ts';

const KEY = 'COOPANION_TEST_BALANCE_KEY';
afterEach(() => { delete process.env[KEY]; });

/** A config whose active endpoint is `entry`; its key is read from the environment. */
const config = (entry: Record<string, unknown> | null) => ({ activeProvider: 'main', providers: entry ? { main: entry } : {} }) as unknown as CoreConfig;
const deepseek = { kind: 'coo', baseUrl: 'https://api.deepseek.com', secret: KEY, spec: { model: 'deepseek-flash' } };
const answering = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('the balance bubble\'s reading', () => {
  it('gives the money left on the account behind the key, under the service\'s name', async () => {
    process.env[KEY] = 'sk-fixture';
    const fetch = answering({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.50', granted_balance: '0', topped_up_balance: '12.50' }] });
    expect(await activeBalance(config(deepseek), 'en', { fetch })).toEqual({ service: 'DeepSeek', amounts: [{ currency: 'CNY', amount: 12.5 }] });
  });

  it('says no key is set, and asks nothing', async () => {
    const fetch = (async () => { throw new Error('asked'); }) as unknown as typeof globalThis.fetch;
    expect(await activeBalance(config(deepseek), 'en', { fetch })).toEqual({ service: 'DeepSeek', none: 'key' });
    expect(await activeBalance(config(null), 'en', { fetch })).toEqual({ service: '', none: 'key' });
  });

  it('says the service tells no balance: one that has no such request, and a ChatGPT plan', async () => {
    process.env[KEY] = 'sk-fixture';
    expect(await activeBalance(config({ ...deepseek, baseUrl: 'https://api.anthropic.com' }), 'en')).toEqual({ service: 'Anthropic', none: 'service' });
    expect(await activeBalance(config({ kind: 'chatgpt', baseUrl: 'https://api.openai.com/v1' }), 'en')).toEqual({ service: 'ChatGPT', none: 'service' });
  });

  it('gives the reason a read failed', async () => {
    process.env[KEY] = 'sk-fixture';
    expect(await activeBalance(config(deepseek), 'en', { fetch: answering({ error: 'Authentication Fails' }, 401) })).toEqual({ service: 'DeepSeek', failed: 'HTTP 401' });
    const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await activeBalance(config(deepseek), 'en', { fetch: offline })).toEqual({ service: 'DeepSeek', failed: 'fetch failed' });
  });
});
