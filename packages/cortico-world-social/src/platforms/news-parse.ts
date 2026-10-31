/**
 * Google News from its RSS feeds: the top stories of an edition, a topic's latest stories, and a
 * search. An edition is Google's `ceid` (country and language, such as `US:en` or `JP:ja`); Google
 * fills in the rest of the address from it. Parsing is plain text work, so it runs in Node.
 */
import type { Language } from 'cortico/core/language.ts';
import type { BrowseRequest } from './adapter.ts';

export const NEWS_ORIGIN = 'https://news.google.com';

/** An edition as Google names it: two capitals for the country, then its language. */
export const EDITION = /^[A-Z]{2}:[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$/;

/** The edition of each app language, for a person who set none. */
const EDITIONS: Record<Language, string> = {
  zh: 'CN:zh-Hans', en: 'US:en', 'zh-Hant': 'TW:zh-Hant', ja: 'JP:ja', ko: 'KR:ko', fr: 'FR:fr', de: 'DE:de',
  'es-419': 'MX:es-419', 'pt-BR': 'BR:pt-419', it: 'IT:it', ru: 'RU:ru',
};

/** The edition set, when it is one; else the app language's. */
export const editionOf = (set: string, language: Language): string => (EDITION.test(set.trim()) ? set.trim() : EDITIONS[language] ?? 'US:en');

/** Google News' topics, by the names the bot may give them. */
const TOPICS: Record<string, string> = {
  world: 'WORLD', international: 'WORLD',
  nation: 'NATION', national: 'NATION', 'u.s.': 'NATION', us: 'NATION', local: 'NATION',
  business: 'BUSINESS', economy: 'BUSINESS', finance: 'BUSINESS',
  technology: 'TECHNOLOGY', tech: 'TECHNOLOGY',
  entertainment: 'ENTERTAINMENT',
  sports: 'SPORTS', sport: 'SPORTS',
  science: 'SCIENCE',
  health: 'HEALTH',
};
export const NEWS_TOPICS = ['world', 'nation', 'business', 'technology', 'entertainment', 'sports', 'science', 'health'] as const;

/** Google News search's own words for a period: articles from the last hour, day, week, month or year. */
const WHEN: Record<string, string> = { hour: '1h', day: '1d', week: '7d', month: '30d', year: '1y' };

/** The period a news search applies, when it applies one. */
export const newsPeriod = (req: BrowseRequest): string | undefined => (req.source === 'search' && req.period && WHEN[req.period] ? req.period : undefined);

/** The feed `req` lists in `edition`: top stories, a topic (one Google News does not have is searched), or a search. */
export function newsFeedUrl(req: BrowseRequest, edition: string): string {
  const ceid = `ceid=${encodeURIComponent(edition)}`;
  const q = req.query.trim();
  if (req.source === 'feed') return `${NEWS_ORIGIN}/rss?${ceid}`;
  const topic = req.source === 'community' ? TOPICS[q.toLowerCase()] : undefined;
  if (topic) return `${NEWS_ORIGIN}/rss/headlines/section/topic/${topic}?${ceid}`;
  const period = newsPeriod(req);
  return `${NEWS_ORIGIN}/rss/search?q=${encodeURIComponent(period ? `${q} when:${WHEN[period]}` : q)}&${ceid}`;
}

export interface NewsItem {
  title: string;
  /** Google News' link, which leads to the article. */
  url: string;
  id: string;
  /** The publisher's name, and its site. */
  source: string;
  sourceUrl: string;
  /** ISO time, when the feed gave one. */
  publishedAt?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** XML text: CDATA as it is, entities decoded. */
export function xmlText(s: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  if (cdata) return cdata[1]!.trim();
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  }).trim();
}

/** The items of a Google News RSS feed; a title's trailing ` - <publisher>` is left off, the publisher being its own field. */
export function parseNewsRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1]!;
    const tag = (name: string) => xmlText(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block)?.[1] ?? '');
    const url = tag('link');
    const raw = tag('title');
    if (!url || !raw) continue;
    const source = tag('source');
    const sourceUrl = xmlText(/<source\s+url="([^"]*)"/.exec(block)?.[1] ?? '');
    const title = source && raw.endsWith(` - ${source}`) ? raw.slice(0, -source.length - 3).trim() : raw;
    const at = Date.parse(tag('pubDate'));
    items.push({
      title, url, id: tag('guid') || url, source, sourceUrl,
      ...(Number.isFinite(at) ? { publishedAt: new Date(at).toISOString() } : {}),
    });
  }
  return items;
}
