/** balance.ts: the balance each service tells a key, read from answers shaped like the services' documented ones. */
import { describe, expect, it } from 'vitest';
import { BalanceFailed, balanceOf, tellsBalance } from '../src/balance.ts';
import { siteOf, vendorById } from '../src/vendors.ts';

/** A fetch that answers every request with `status` and `body`, and keeps what was asked. */
function answering(body: unknown, status = 200) {
  const asked: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    asked.push({ url, headers: init?.headers as Record<string, string> });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

const site = (id: string, region: 'cn' | 'intl' = 'cn') => siteOf(vendorById(id)!, region).baseUrl;

describe('the balance a service tells a key', () => {
  it("reads DeepSeek's balance in each currency, asking with the key", async () => {
    const { fetch, asked } = answering({ is_available: true, balance_infos: [
      { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      { currency: 'USD', total_balance: '2.5', granted_balance: '0', topped_up_balance: '2.5' },
    ] });
    expect(await balanceOf(site('deepseek'), 'sk-fixture', { fetch })).toEqual([{ currency: 'CNY', amount: 110 }, { currency: 'USD', amount: 2.5 }]);
    expect(asked).toEqual([{ url: 'https://api.deepseek.com/user/balance', headers: { authorization: 'Bearer sk-fixture', accept: 'application/json' } }]);
  });

  it("reads Kimi's available balance, in yuan on the mainland platform and dollars on the international one", async () => {
    const answer = { code: 0, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 }, scode: '0x0', status: true };
    const cn = answering(answer);
    expect(await balanceOf(site('kimi', 'cn'), 'sk-fixture', { fetch: cn.fetch })).toEqual([{ currency: 'CNY', amount: 49.58894 }]);
    expect(cn.asked[0]!.url).toBe('https://api.moonshot.cn/v1/users/me/balance');
    const intl = answering(answer);
    expect(await balanceOf(site('kimi', 'intl'), 'sk-fixture', { fetch: intl.fetch })).toEqual([{ currency: 'USD', amount: 49.58894 }]);
    expect(intl.asked[0]!.url).toBe('https://api.moonshot.ai/v1/users/me/balance');
  });

  it("reads what is left under an OpenRouter key's own limit, and nothing for a key without one", async () => {
    const limited = answering({ data: { label: 'fixture', limit: 20, limit_remaining: 12.25, usage: 7.75 } });
    expect(await balanceOf(site('openrouter'), 'sk-or-fixture', { fetch: limited.fetch })).toEqual([{ currency: 'USD', amount: 12.25 }]);
    expect(limited.asked[0]!.url).toBe('https://openrouter.ai/api/v1/key');
    const unlimited = answering({ data: { label: 'fixture', limit: null, limit_remaining: null, usage: 7.75 } });
    expect(await balanceOf(site('openrouter'), 'sk-or-fixture', { fetch: unlimited.fetch })).toBeNull();
  });

  it('asks nothing of a service that tells its keys no balance, or of an address that is no service', async () => {
    const { fetch, asked } = answering({});
    expect(await balanceOf(site('anthropic'), 'sk-fixture', { fetch })).toBeNull();
    expect(await balanceOf('http://127.0.0.1:8080/v1', 'sk-fixture', { fetch })).toBeNull();
    expect(await balanceOf(undefined, 'sk-fixture', { fetch })).toBeNull();
    expect(asked).toEqual([]);
    expect([tellsBalance(site('deepseek')), tellsBalance(site('kimi', 'intl')), tellsBalance(site('openrouter')), tellsBalance(site('anthropic'))]).toEqual([true, true, true, false]);
  });

  it('names the failure when the service refuses, or answers without a balance', async () => {
    const failure = async (body: unknown, status = 200, id = 'deepseek') => (await balanceOf(site(id), 'sk-fixture', { fetch: answering(body, status).fetch }).catch((e: unknown) => e)) as BalanceFailed;
    expect(await failure({ error: { message: 'Authentication Fails' } }, 401)).toMatchObject({ detail: 'HTTP 401' });
    expect(await failure('<html>gateway</html>')).toMatchObject({ detail: 'the answer was not JSON' });
    expect(await failure({ is_available: false })).toMatchObject({ detail: 'the answer has no balance_infos' });
    expect(await failure({ code: 5, error: 'invalid key' }, 200, 'kimi')).toMatchObject({ detail: 'invalid key' });
    expect(await failure({ code: 0, data: {} }, 200, 'kimi')).toBeInstanceOf(BalanceFailed);
  });
});
