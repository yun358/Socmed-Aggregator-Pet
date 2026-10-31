/**
 * Any web page read as an article: its title, site, byline and time from the page's own metadata
 * (Open Graph, schema.org JSON-LD), and its text from the block of the page that holds the most
 * paragraph text, menus, asides, footers, forms and link lists left out. A page's own `articleBody`
 * (JSON-LD) is taken instead when it is the longer. A page that is a bot check (Cloudflare,
 * DataDome, PerimeterX and the like) is told apart, so the person can pass it in a window.
 */
import type { PageSession } from '../browser.ts';
import { PlatformBlocked } from '../collect.ts';
import { clean, type PlatformId, type Post } from '../posts.ts';

export interface ArticleRead {
  /** Where the page ended up. */
  url: string;
  title: string;
  site: string;
  byline: string;
  /** The publication time as the page states it; empty when it states none. */
  published: string;
  /**
   * Paragraphs, separated by blank lines; headings start with `## `, list items with `- `. A page that
   * is no article (a site's front page) gives its headlines instead, one `- ` line each with its link.
   */
  text: string;
  /** The page's own summary (meta description), for a page whose text could not be found. */
  description: string;
}

/** Reads the page as an article. Runs in the page, so it carries its own helpers. */
export function readArticle(): ArticleRead {
  // parts of a page that are never the article
  const NOT_TEXT = 'nav, aside, footer, form, button, select, script, style, noscript, svg, iframe, figcaption, [role="navigation"], [role="complementary"], [role="contentinfo"], [role="banner"], [role="dialog"]';
  // blocks named for what is around an article, unless the name also says it is the article
  const AROUND = /advert|newsletter|related|share|social|promo|subscribe|comment|cookie|consent|recommend|sidebar|widget|popup|modal/i;
  const ARTICLE = /article|body|content|main|story|entry|post|text/i;
  const around = (el: Element): boolean => {
    if (el.closest(NOT_TEXT)) return true;
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const named = `${typeof e.className === 'string' ? e.className : ''} ${e.id}`;
      if (AROUND.test(named) && !ARTICLE.test(named)) return true;
    }
    return false;
  };
  const meta = (selector: string) => document.querySelector(selector)?.getAttribute('content')?.trim() ?? '';
  const text = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();

  // schema.org data the page carries for search engines: the article itself, in a list or a @graph
  const ld: Array<Record<string, unknown>> = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const types = ([] as unknown[]).concat(o['@type'] ?? []).map(String);
    if (types.some((x) => /Article|BlogPosting|Report/i.test(x))) ld.push(o);
    if (o['@graph']) walk(o['@graph']);
  };
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try { walk(JSON.parse(s.textContent ?? '')); } catch { /* a page's broken data is skipped */ }
  }
  const art = ld[0] ?? {};
  const name = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(name).filter(Boolean).join(', ');
    if (v && typeof v === 'object') return String((v as Record<string, unknown>).name ?? '');
    return '';
  };

  // the article's text is in the smallest block that holds most of the page's paragraph text, however the page splits it up
  const totals = new Map<Element, number>();
  let all = 0;
  for (const p of Array.from(document.querySelectorAll('p, pre, blockquote'))) {
    const n = text(p).length;
    if (n < 25 || around(p)) continue;
    all += n;
    for (let el = p.parentElement; el; el = el.parentElement) totals.set(el, (totals.get(el) ?? 0) + n);
  }
  let root: Element = document.body;
  for (const [el, n] of totals) if (n >= all * 0.7 && root.contains(el)) root = el;

  const out: string[] = [];
  for (const el of Array.from(root.querySelectorAll('h2, h3, h4, p, li, blockquote, pre'))) {
    if (el.querySelector('p, li, h2, h3, h4, blockquote, pre') || around(el)) continue;
    const s = text(el);
    if (!s) continue;
    // a line that is mostly links is navigation, a tag list or a list of other stories
    const linked = Array.from(el.querySelectorAll('a')).reduce((n, a) => n + text(a).length, 0);
    if (linked / s.length > 0.6 && s.length < 300) continue;
    const line = /^H[2-4]$/.test(el.tagName) ? `## ${s}` : el.tagName === 'LI' ? `- ${s}` : s;
    if (out[out.length - 1] !== line) out.push(line);
  }
  let body = out.join('\n\n');
  const ldBody = typeof art.articleBody === 'string' ? art.articleBody.trim() : '';
  if (ldBody.length > body.length) body = ldBody;

  // a page that is no article, such as a site's front page: its headlines, each with its link
  const isArticle = ld.length > 0 || /article/i.test(meta('meta[property="og:type"]'));
  if (!isArticle) {
    const heads: string[] = [];
    const seen = new Set<string>();
    for (const h of Array.from(document.querySelectorAll('h1 a[href], h2 a[href], h3 a[href], h4 a[href], a[href] h2, a[href] h3, a[href] h4'))) {
      const a = (h.matches('a') ? h : h.closest('a')) as HTMLAnchorElement;
      const s = text(h);
      if (s.length < 15 || around(h) || seen.has(a.href)) continue;
      seen.add(a.href);
      heads.push(`- ${s} ${a.href}`);
      if (heads.length >= 60) break;
    }
    if (heads.length >= 5) body = heads.join('\n');
  }

  const h1 = document.querySelector('h1');
  const author = document.querySelector('[rel="author"], [itemprop="author"]');
  return {
    url: location.href,
    title: meta('meta[property="og:title"]') || name(art.headline) || (h1 ? text(h1) : '') || document.title.trim(),
    site: meta('meta[property="og:site_name"]') || name(art.publisher) || location.hostname.replace(/^www\./, ''),
    byline: meta('meta[name="author"]') || name(art.author) || (author ? text(author) : ''),
    published: meta('meta[property="article:published_time"]') || name(art.datePublished) || (document.querySelector('time[datetime]')?.getAttribute('datetime') ?? ''),
    text: body,
    description: meta('meta[property="og:description"]') || meta('meta[name="description"]'),
  };
}

/** The kind of bot check the page is, if it is one. Runs in the page. */
export function botCheck(): 'captcha' | null {
  const title = document.title.toLowerCase();
  if (/just a moment|attention required|are you a robot|verify you are human|access to this page has been denied|security check/.test(title)) return 'captcha';
  const marks = '#challenge-form, #cf-challenge-running, .cf-browser-verification, iframe[src*="challenges.cloudflare.com"], iframe[src*="captcha-delivery.com"], [id^="px-captcha"], #captcha-form';
  return document.querySelector(marks) ? 'captcha' : null;
}

/** The article `read` gave, as a post of `platform`; null when the page had neither text nor a title. */
export function articlePost(platform: PlatformId, read: ArticleRead): Post | null {
  const text = clean(read.text) || clean(read.description);
  const title = clean(read.title);
  if (!text && !title) return null;
  const at = Date.parse(read.published);
  return {
    platform, id: read.url, url: read.url, text,
    ...(title ? { title } : {}),
    ...(clean(read.site) ? { community: clean(read.site) } : {}),
    ...(clean(read.byline) ? { author: clean(read.byline) } : {}),
    ...(Number.isFinite(at) ? { publishedAt: new Date(at).toISOString() } : {}),
    stats: [], images: [], video: false, extraction: 'adapter',
  };
}

/** The page open now, read as an article of `platform`; a bot check is a block the person can pass with `social_login`. */
export async function readOpenArticle(page: PageSession, platform: PlatformId): Promise<Post | null> {
  for (let tries = 0; ; tries++) {
    try {
      if (await page.run(botCheck, undefined)) throw new PlatformBlocked(platform, 'captcha', page.url());
      return articlePost(platform, await page.run(readArticle, undefined));
    } catch (err) {
      // the page went on to another address while it was read: read that one
      if (tries || !/context was destroyed|navigat/i.test(String((err as Error)?.message))) throw err;
      await page.pause(1500);
    }
  }
}
