/** news-parse.ts: Google News' feed addresses for an edition, and its RSS read into stories. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EDITION, NEWS_TOPICS, editionOf, newsFeedUrl, newsPeriod, parseNewsRss, xmlText } from '../src/platforms/news-parse.ts';

/** An RSS feed shaped like Google News' own, its publishers made up. */
const NEWS_RSS = readFileSync(new URL('./fixtures/news-rss.xml', import.meta.url), 'utf8');

describe('Google News feeds', () => {
  it('reads each story: its headline without the publisher, the publisher apart, the link, the id and the time', () => {
    expect(parseNewsRss(NEWS_RSS)).toEqual([
      { title: 'Harbour reopens after the storm', url: 'https://news.google.com/rss/articles/CBMiFixtureOne?oc=5', id: 'CBMiFixtureOne', source: 'Fixture Times', sourceUrl: 'https://times.fixture.test', publishedAt: '2026-10-31T22:47:59.000Z' },
      { title: 'Q&A: what the new rail line means', url: 'https://news.google.com/rss/articles/CBMiFixtureTwo?oc=5', id: 'CBMiFixtureTwo', source: 'The Fixture Post', sourceUrl: 'https://post.fixture.test', publishedAt: '2026-10-31T21:05:00.000Z' },
      { title: 'Markets & more: a quiet week — for once', url: 'https://news.google.com/rss/articles/CBMiFixtureThree?oc=5', id: 'CBMiFixtureThree', source: 'Fixture Daily', sourceUrl: 'https://daily.fixture.test' },
    ]);
    expect(parseNewsRss('<html>not a feed</html>')).toEqual([]);
  });

  it('decodes XML text: CDATA as it is, named and numbered entities, and leaves an unknown entity', () => {
    expect(xmlText('<![CDATA[ a & b ]]>')).toBe('a & b');
    expect(xmlText('Tom &amp; Jerry &lt;3 &#x4E2D;&#25991; &unknown;')).toBe('Tom & Jerry <3 中文 &unknown;');
  });

  it("lists the edition's top stories, a topic's latest, and a search, a period kept as Google's own words", () => {
    const at = (source: 'feed' | 'search' | 'community', query = '', period?: string) => newsFeedUrl({ source, query, period }, 'SG:en');
    expect(at('feed')).toBe('https://news.google.com/rss?ceid=SG%3Aen');
    expect(at('community', 'Technology')).toBe('https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?ceid=SG%3Aen');
    expect(at('community', 'tech')).toBe('https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?ceid=SG%3Aen');
    // a topic Google News does not have is searched
    expect(at('community', 'electric cars')).toBe('https://news.google.com/rss/search?q=electric%20cars&ceid=SG%3Aen');
    expect(at('search', 'electric cars', 'day')).toBe('https://news.google.com/rss/search?q=electric%20cars%20when%3A1d&ceid=SG%3Aen');
    expect(at('search', 'electric cars', 'all')).toBe('https://news.google.com/rss/search?q=electric%20cars&ceid=SG%3Aen');
    expect([newsPeriod({ source: 'search', query: 'x', period: 'week' }), newsPeriod({ source: 'feed', query: '', period: 'week' }), newsPeriod({ source: 'search', query: 'x', period: 'all' })]).toEqual(['week', undefined, undefined]);
    for (const topic of NEWS_TOPICS) expect(newsFeedUrl({ source: 'community', query: topic }, 'US:en')).toContain(`/topic/${topic.toUpperCase()}?`);
  });

  it('takes the edition set when it is one, else the app language\'s', () => {
    expect(editionOf(' GB:en ', 'zh')).toBe('GB:en');
    expect(editionOf('', 'en')).toBe('US:en');
    expect(editionOf('england', 'ja')).toBe('JP:ja');
    expect(['US:en', 'BR:pt-419', 'TW:zh-Hant', 'MX:es-419', 'PT:pt-150'].every((e) => EDITION.test(e))).toBe(true);
    expect(['us:en', 'USA:en', 'US-en', 'US:'].some((e) => EDITION.test(e))).toBe(false);
  });
});
