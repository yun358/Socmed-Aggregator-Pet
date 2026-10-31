/**
 * The web: a search on a search engine's own results page, and any page read as an article
 * (`article.ts`). Bing is asked first, then DuckDuckGo, then Google: an engine that shows a bot check,
 * cannot be reached, finds nothing, or answers off the topic (none of its first results names a word of the query, as
 * an engine does that takes a browser for a bot) hands the search to the next; when none answers
 * on the topic, the first results found are given. A result is its title, the snippet under it, its
 * site and its link, the engine's own redirect taken off; ads are left out.
 */
import { Interrupted, TimeUp } from '../browser.ts';
import { PlatformBlocked } from '../collect.ts';
import type { Post } from '../posts.ts';
import type { Adapter } from './adapter.ts';
import { readOpenArticle } from './article.ts';

export type Engine = 'bing' | 'duckduckgo' | 'google';

/** The engines in the order they are asked, with their results page for `q`. */
export const ENGINES: ReadonlyArray<{ id: Engine; url: (q: string) => string }> = [
  { id: 'bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  { id: 'duckduckgo', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` },
  { id: 'google', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
];

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  site: string;
}

/** The results on `engine`'s page, or the check it shows instead. Runs in the page. */
export function readSearchResults(engine: Engine): { results: SearchResult[] } | { check: 'captcha' | 'consent' } {
  const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  /** The address an engine's redirect link leads to. */
  const target = (href: string): string => {
    let u: URL;
    try { u = new URL(href, location.href); } catch { return ''; }
    // Bing: /ck/a?…&u=a1<the address in base64url>
    const b = u.hostname.endsWith('bing.com') && u.pathname === '/ck/a' ? u.searchParams.get('u') : null;
    if (b && b.startsWith('a1')) {
      try {
        const s = b.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        const bytes = Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
      } catch { return ''; }
    }
    // DuckDuckGo: /l/?uddg=<the address>; Google: /url?q=<the address>
    if (u.hostname.endsWith('duckduckgo.com') && u.pathname.startsWith('/l/')) return u.searchParams.get('uddg') ?? '';
    if (u.hostname.endsWith('google.com') && u.pathname === '/url') return u.searchParams.get('q') ?? u.searchParams.get('url') ?? '';
    return u.href;
  };
  const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const results: SearchResult[] = [];
  const add = (href: string, title: string, snippet: string, site: string) => {
    let url = target(href);
    if (!/^https?:\/\//.test(url) || !title) return;
    // Bing marks the addresses it leads to with its own visit id
    try { const u = new URL(url); u.searchParams.delete('msockid'); url = u.href; } catch { return; }
    if (!results.some((r) => r.url === url)) results.push({ url, title, snippet, site: site || host(url) });
  };
  const words = text(document.body).toLowerCase();

  if (engine === 'bing') {
    for (const li of Array.from(document.querySelectorAll('#b_results > li.b_algo'))) {
      const a = li.querySelector<HTMLAnchorElement>('h2 a[href]');
      if (a) add(a.href, text(a), text(li.querySelector('.b_caption p, [class^="b_lineclamp"], .b_paractl')), text(li.querySelector('.tptt')));
    }
    if (!results.length && /solve the challenge|verify you are a human|unusual traffic/.test(words)) return { check: 'captcha' };
  } else if (engine === 'duckduckgo') {
    for (const r of Array.from(document.querySelectorAll('.result'))) {
      if (r.matches('.result--ad')) continue;
      const a = r.querySelector<HTMLAnchorElement>('a.result__a[href]');
      if (a) add(a.href, text(a), text(r.querySelector('.result__snippet')), '');
    }
    if (!results.length && (document.querySelector('.anomaly-modal, #challenge-form') || /bots use duckduckgo/.test(words))) return { check: 'captcha' };
  } else {
    if (location.hostname.startsWith('consent.')) return { check: 'consent' };
    if (location.pathname.startsWith('/sorry') || document.querySelector('#captcha-form')) return { check: 'captcha' };
    for (const h3 of Array.from(document.querySelectorAll('#search a[href] h3, #rso a[href] h3'))) {
      const a = h3.closest('a') as HTMLAnchorElement;
      if (target(a.href).includes('google.')) continue;
      const box = a.closest('[data-hveid], .g') ?? a.parentElement;
      const snippet = text(box?.querySelector('[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"]'));
      add(a.href, text(h3), snippet, '');
    }
  }
  return { results };
}

/** Words too common to tell whether results are on a query's topic. */
const COMMON = new Set(['the', 'and', 'for', 'how', 'what', 'why', 'when', 'where', 'who', 'which', 'does', 'did', 'are', 'was', 'were', 'can', 'with', 'from', 'about', 'into', 'that', 'this', 'there', 'their', 'your', 'best', 'top', 'get', 'make', 'use']);
/** Results checked for the query's words. */
const CHECKED = 3;

/** Whether the first results name any word of `query` that tells its topic; a query without such words (most CJK ones) passes. */
export function onTopic(results: readonly SearchResult[], query: string): boolean {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && w.length <= 20 && !COMMON.has(w) && !/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(w));
  if (!words.length) return true;
  return results.slice(0, CHECKED).some((r) => words.some((w) => `${r.title} ${r.snippet}`.toLowerCase().includes(w)));
}

/** A search result as a post: its title, the snippet as its text, its site and its link. */
export const resultPost = (r: SearchResult): Post => ({
  platform: 'web', id: r.url, url: r.url, title: r.title, text: r.snippet, community: r.site,
  stats: [], images: [], video: false, extraction: 'adapter',
});

export const WEB: Adapter = {
  id: 'web',
  // the person passes an engine's check here; a site's own login or check opens at its page (`social_login` with a url)
  loginUrl: 'https://www.bing.com/',
  session: { domain: '.bing.com', cookies: [] },
  sources: ['search'],

  async list(page, req, collector) {
    const query = req.query.trim();
    const checks: string[] = [];
    let offTopic: SearchResult[] | null = null;
    for (const engine of ENGINES) {
      if (collector.done) return;
      let found: ReturnType<typeof readSearchResults>;
      try {
        await page.goto(engine.url(query));
        found = await page.run(readSearchResults, engine.id);
      } catch (err) {
        // an engine out of reach is passed over like one that turns the browser away
        if (err instanceof Interrupted || err instanceof TimeUp) throw err;
        checks.push(`${engine.id}: ${String((err as Error)?.message ?? err).split('\n')[0]}`);
        continue;
      }
      if ('check' in found) {
        checks.push(`${engine.id}: ${found.check}`);
        continue;
      }
      if (!found.results.length) continue;
      if (!onTopic(found.results, query)) {
        offTopic ??= found.results;
        continue;
      }
      for (const r of found.results) if (!collector.offer(resultPost(r))) return;
      return;
    }
    if (offTopic) {
      for (const r of offTopic) if (!collector.offer(resultPost(r))) return;
      return;
    }
    // every engine stood in the way: the person can pass the first one's check in a window
    if (checks.length === ENGINES.length) throw new PlatformBlocked('web', 'captcha', checks.join(', '));
  },

  // any page no platform owns is read here (`world.ts`)
  owns: () => false,

  async read(page, url) {
    await page.goto(url);
    // a page that is still building itself has no text yet
    await page.waitFor('p, h1, h2', 5000);
    const post = await readOpenArticle(page, 'web');
    return post ? { post, comments: [] } : null;
  },
};
