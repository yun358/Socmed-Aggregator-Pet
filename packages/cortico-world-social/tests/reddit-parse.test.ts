/** reddit-parse.ts: Reddit's listing and thread JSON read into posts and comments. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRedditListing, parseRedditThread, redditPost } from '../src/platforms/reddit-parse.ts';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('parseRedditListing', () => {
  const listing = parseRedditListing(fixture('reddit-listing.json'));
  const byId = (id: string) => listing.posts.find((p) => p.id === id)!;

  it('leaves pinned posts out, counts them, and keeps the rest in listing order with the next-page cursor', () => {
    expect(listing.stickied).toBe(1);
    expect(listing.posts.map((p) => p.id)).toEqual(['fx0002', 'fx0003', 'fx0004', 'fx0005', 'fx0006', 'fx0007', 'fx0008']);
    expect(listing.after).toBe('t3_fx0008');
  });

  it('reads a text post: author, community, title and text with layout whitespace joined, exact time and counts', () => {
    const p = byId('fx0002');
    expect(p).toMatchObject({
      platform: 'reddit',
      url: 'https://www.reddit.com/r/fixturetown/comments/fx0002/quarterly_numbers_are_out/',
      author: 'u/fixture_alice',
      community: 'r/fixturetown',
      title: 'Quarterly numbers are out',
      text: 'Revenue rose 12%.\nMargins held steady.',
      publishedAt: new Date(1792634400 * 1000).toISOString(),
      images: [],
      video: false,
      extraction: 'adapter',
    });
    expect(p.stats).toEqual([['points', '420'], ['comments', '37']]);
  });

  it('marks hosted videos and links to video sites as video posts', () => {
    expect(byId('fx0003').video).toBe(true);
    expect(byId('fx0007').video).toBe(true);
    expect(byId('fx0002').video).toBe(false);
  });

  it('reads an image post with its URL entities decoded', () => {
    expect(byId('fx0004').images).toEqual([{ url: 'https://i.redd.it/fixturemenu.png?width=640&format=png' }]);
    expect(byId('fx0004').text).toBe('');
  });

  it('reads a gallery in the gallery order with its captions', () => {
    expect(byId('fx0005').images).toEqual([
      { url: 'https://preview.redd.it/fxmediab.jpg?width=1080&format=pjpg', alt: 'Fruit stall' },
      { url: 'https://preview.redd.it/fxmediaa.jpg?width=1080&format=pjpg' },
    ]);
  });

  it('gives a link post its target as text', () => {
    expect(byId('fx0006').text).toBe('https://news.example.org/harbour-story');
    expect(byId('fx0006').images).toEqual([]);
  });

  it('keeps a zero score as a count', () => {
    expect(byId('fx0008').stats).toContainEqual(['points', '0']);
  });

  it('reads anything that is not a listing as an empty one', () => {
    for (const raw of [null, {}, { data: {} }, [], 'html']) expect(parseRedditListing(raw)).toEqual({ posts: [], after: null, stickied: 0 });
  });
});

describe('redditPost', () => {
  it('builds the URL from the id when the post has no permalink', () => {
    expect(redditPost({ id: 'fx0100', title: 'x' }).url).toBe('https://www.reddit.com/comments/fx0100');
  });

  it('reads a direct image link without a post hint as an image', () => {
    expect(redditPost({ id: 'fx0101', url: 'https://i.example.org/photo.JPG', permalink: '/r/a/comments/fx0101/x/' }).images)
      .toEqual([{ url: 'https://i.example.org/photo.JPG' }]);
  });
});

describe('parseRedditThread', () => {
  it('returns the post and its top-level comments in order, deleted and removed ones and "more" stubs left out', () => {
    const { post, comments } = parseRedditThread(fixture('reddit-thread.json'), 10);
    expect(post?.id).toBe('fx0002');
    expect(comments).toEqual([
      { author: 'u/fixture_gus', text: 'Better than last quarter.', score: '120 points' },
      { author: 'u/fixture_ivy', text: 'Guidance for next year is lower.', score: '64 points' },
      { author: 'u/fixture_jon', text: 'Holding my shares.', score: '30 points' },
    ]);
  });

  it('stops at the number of comments asked for', () => {
    expect(parseRedditThread(fixture('reddit-thread.json'), 2).comments.map((c) => c.author)).toEqual(['u/fixture_gus', 'u/fixture_ivy']);
    expect(parseRedditThread(fixture('reddit-thread.json'), 0).comments).toEqual([]);
  });

  it('gives no post for a payload that is not a thread', () => {
    expect(parseRedditThread({ kind: 'Listing' }, 5)).toEqual({ post: null, comments: [] });
  });
});
