/** Threads from its pages: the home feed, search, a profile, and a post with its replies. */
import type { PageSession } from '../browser.ts';
import { PlatformBlocked, domToPost, scrollCollect } from '../collect.ts';
import { DOM_READ_DEFAULTS, readThreadsPosts } from './dom.ts';
import { accountName, hostIs, type Adapter } from './adapter.ts';

const ORIGIN = 'https://www.threads.com';
const READY = 'div[data-pressable-container="true"]';

async function open(page: PageSession, url: string): Promise<void> {
  const at = await page.goto(url);
  if (new URL(at).pathname.startsWith('/login')) throw new PlatformBlocked('threads', 'login');
}

export const THREADS: Adapter = {
  id: 'threads',
  loginUrl: `${ORIGIN}/login`,
  session: { domain: '.threads.com', cookies: ['sessionid'] },
  sources: ['feed', 'search', 'account'],

  async list(page, req, collector) {
    const url = req.source === 'feed' ? `${ORIGIN}/`
      : req.source === 'search' ? `${ORIGIN}/search?q=${encodeURIComponent(req.query.trim())}&serp_type=default${req.sort === 'recent' || req.sort === 'latest' ? '&filter=recent' : ''}`
      : `${ORIGIN}/@${encodeURIComponent(accountName(req.query))}`;
    await open(page, url);
    await scrollCollect(page, collector, { reader: readThreadsPosts, ready: READY });
  },

  owns: (url) => hostIs(url, 'threads.com', 'threads.net'),

  async read(page, url, maxComments) {
    await open(page, `${ORIGIN}${new URL(url).pathname}`);
    await page.waitFor(READY, 10_000);
    const [first, ...rest] = await page.run(readThreadsPosts, DOM_READ_DEFAULTS);
    if (!first) return null;
    return {
      post: domToPost('threads', first, 'adapter'),
      comments: rest.slice(0, maxComments).map((r) => ({ author: r.author || undefined, text: r.text })),
    };
  },
};
