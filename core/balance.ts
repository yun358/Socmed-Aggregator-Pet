/** The pet's balance bubble's reading, lent to the desktop pet World in companion.ts. */
import { join } from 'node:path';
import type { Language } from 'cortico/core/language.ts';
import { secretReader } from 'cortico/core/secrets.ts';
import type { CoreConfig } from 'cortico/core/types.ts';
import { providersRoot } from 'cortico/paths.ts';
import type { PetBalance } from 'cortico-world-desktop-pet';
import { BalanceFailed, CHATGPT, CHATGPT_PROVIDER, balanceOf, tellsBalance, vendorName, vendorOf } from 'cortico-provider-coo';

/**
 * What the pet's balance bubble shows for the active endpoint: the balance its service tells the
 * endpoint's key, under the service's name in `language`.
 */
export async function activeBalance(config: CoreConfig | null, language: Language, opts: { fetch?: typeof fetch } = {}): Promise<PetBalance> {
  const entry = config?.providers[config.activeProvider];
  if (!config || !entry) return { service: '', none: 'key' };
  if (entry.kind === CHATGPT_PROVIDER.id) return { service: vendorName(CHATGPT, language), none: 'service' };
  const vendor = vendorOf(entry.baseUrl);
  const service = vendor ? vendorName(vendor, language) : '';
  if (!tellsBalance(entry.baseUrl)) return { service, none: 'service' };
  const key = entry.secret ? secretReader(join(providersRoot(), config.activeProvider, '.env'))(entry.secret) : '';
  if (!key) return { service, none: 'key' };
  try {
    const amounts = await balanceOf(entry.baseUrl, key, opts);
    return amounts ? { service, amounts } : { service, none: 'service' };
  } catch (err) {
    return { service, failed: err instanceof BalanceFailed ? err.detail : (err as Error).message };
  }
}
