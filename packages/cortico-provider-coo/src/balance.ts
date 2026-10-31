/**
 * What is left on the account behind a model service's key, for the services that tell the key
 * itself: DeepSeek (`GET /user/balance`), Kimi (`GET /users/me/balance`, in yuan on the mainland
 * platform and dollars on the international one) and OpenRouter (`GET /key`, the credit left under
 * the key's own limit; a key without a limit has none to tell). The other services report a balance
 * only to another kind of key, or not at all. Requests go to the platform's base URL from `vendors.ts`.
 */
import { locate, type Region } from './vendors.ts';

/** An amount of money in an ISO 4217 currency. */
export interface Money {
  currency: string;
  amount: number;
}

/** The service answered, but not with a balance: `detail` is its status or reason. */
export class BalanceFailed extends Error {
  constructor(readonly detail: string) { super(`balance not read: ${detail}`); }
}

/** Time one balance request may take. */
const BALANCE_MS = 10_000;

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** How a service tells a key its balance: the path after its base URL, and the money read from the answer (null: none to tell). */
interface BalanceRequest {
  path: string;
  read(json: unknown, region: Region | null): Money[] | null;
}

const REQUESTS: Readonly<Record<string, BalanceRequest>> = {
  // {"is_available": true, "balance_infos": [{"currency": "CNY", "total_balance": "110.00", ...}]}
  deepseek: {
    path: '/user/balance',
    read: (json) => {
      const infos = obj(json)?.balance_infos;
      if (!Array.isArray(infos)) throw new BalanceFailed('the answer has no balance_infos');
      return infos.map(obj).flatMap((i) => {
        const amount = num(i?.total_balance);
        return typeof i?.currency === 'string' && amount !== null ? [{ currency: i.currency, amount }] : [];
      });
    },
  },
  // {"code": 0, "data": {"available_balance": 49.58894, "voucher_balance": ..., "cash_balance": ...}, "status": true}
  kimi: {
    path: '/users/me/balance',
    read: (json, region) => {
      const d = obj(json);
      const amount = num(obj(d?.data)?.available_balance);
      if (d?.code !== 0 || amount === null) throw new BalanceFailed(typeof d?.error === 'string' ? d.error : 'the answer has no available_balance');
      return [{ currency: region === 'cn' ? 'CNY' : 'USD', amount }];
    },
  },
  // {"data": {"limit": 100, "limit_remaining": 74.5, "usage": 25.5, ...}}; limit_remaining is null without a limit
  openrouter: {
    path: '/key',
    read: (json) => {
      const d = obj(obj(json)?.data);
      if (!d) throw new BalanceFailed('the answer has no data');
      const left = num(d.limit_remaining);
      return left === null ? null : [{ currency: 'USD', amount: left }];
    },
  },
};

/** Whether the service an endpoint's base URL points at tells its keys their balance. */
export const tellsBalance = (baseUrl: string | undefined): boolean => !!REQUESTS[locate(baseUrl)?.vendor.id ?? ''];

/**
 * The balance of the account behind `key` on the service `baseUrl` points at; null when the service
 * tells this key none. Throws `BalanceFailed` when the service answers with an error or without a
 * balance, and the fetch's own error when it cannot be reached.
 */
export async function balanceOf(baseUrl: string | undefined, key: string, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<Money[] | null> {
  const at = locate(baseUrl);
  const request = at && REQUESTS[at.vendor.id];
  if (!at || !request) return null;
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(BALANCE_MS)]) : AbortSignal.timeout(BALANCE_MS);
  const res = await (opts.fetch ?? fetch)(`${at.site.baseUrl}${request.path}`, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal });
  const text = await res.text();
  if (!res.ok) throw new BalanceFailed(`HTTP ${res.status}`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BalanceFailed('the answer was not JSON');
  }
  return request.read(json, at.region);
}
