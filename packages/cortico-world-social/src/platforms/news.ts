/**
 * Google News: the top stories of the person's edition, a topic's latest stories, and a search,
 * listed from its RSS feeds (`news-parse.ts`) fetched from a news.google.com page. A story's link
 * leads through Google News to the publisher's page, where the article is read (`article.ts`).
 * Google News needs no login; where the law asks, it asks about cookies first, on consent.google.com.
 */
import type { PageSession } from '../browser.ts';
import { PlatformBlocked } from '../collect.ts';
import { hostIs, type Adapter } from './adapter.ts';
import { readOpenArticle } from './article.ts';
import { NEWS_ORIGIN, newsFeedUrl, newsPeriod, parseNewsRss } from './news-parse.ts';

/** Seconds a story's link may take to lead from Google News to the article. */
const REDIRECT_MS = 10_000;
const STEP_MS = 250;

/** A page on news.google.com to fetch the feeds from; robots.txt is small and needs no script. */
async function onNews(page: PageSession): Promise<void> {
  if (page.url().startsWith(`${NEWS_ORIGIN}/`)) return;
  const at = await page.goto(`${NEWS_ORIGIN}/robots.txt`);
  if (new URL(at).hostname.startsWith('consent.')) throw new PlatformBlocked('news', 'consent');
}

export const NEWS: Adapter = {
  id: 'news',
  loginUrl: `${NEWS_ORIGIN}/`,
  session: { domain: '.google.com', cookies: [] },
  sources: ['feed', 'search', 'community'],

  applied: (req) => ({ period: newsPeriod(req) }),

  async list(page, req, collector) {
    await onNews(page);
    const rep = await page.fetchText(newsFeedUrl(req, req.region ?? 'US:en'));
    if (rep.status >= 400) throw new PlatformBlocked('news', 'blocked', `HTTP ${rep.status}`);
    for (const item of parseNewsRss(rep.text)) {
      const post = {
        platform: 'news' as const, id: item.id, url: item.url, title: item.title, text: '',
        ...(item.source ? { community: item.source } : {}),
        ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
        stats: [], images: [], video: false, extraction: 'adapter' as const,
      };
      if (!collector.offer(post)) return;
    }
  },

  owns: (url) => hostIs(url, 'news.google.com'),

  async read(page, url) {
    await page.goto(url);
    // the story's page sends the browser on to the publisher's article
    for (let waited = 0; waited < REDIRECT_MS && hostIs(new URL(page.url()), 'news.google.com'); waited += STEP_MS) await page.pause(STEP_MS);
    const at = new URL(page.url());
    if (at.hostname.startsWith('consent.')) throw new PlatformBlocked('news', 'consent');
    if (hostIs(at, 'news.google.com')) return null;
    await page.waitFor('p, h1, h2', 5000);
    const post = await readOpenArticle(page, 'news');
    return post ? { post, comments: [] } : null;
  },
};
