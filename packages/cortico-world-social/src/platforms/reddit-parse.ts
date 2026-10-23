/**
 * Reddit's JSON listings (`/r/<name>/top.json`, `/search.json`, `/comments/<id>.json`) read into posts,
 * and the inbox (`/message/unread.json`) into replies.
 */
import { clean, type Comment, type ImageRef, type Post } from '../posts.ts';

const ORIGIN = 'https://www.reddit.com';

interface Thing {
  kind?: string;
  data?: Record<string, unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** `raw_json=1` leaves `&amp;` in older payloads' URLs; Reddit's image hosts need them decoded. */
const decodeUrl = (u: string): string => u.replace(/&amp;/g, '&');

function images(d: Record<string, unknown>): ImageRef[] {
  const out: ImageRef[] = [];
  const meta = d.media_metadata as Record<string, { e?: string; s?: { u?: string; gif?: string } }> | undefined;
  const gallery = (d.gallery_data as { items?: Array<{ media_id?: string; caption?: string }> } | undefined)?.items;
  if (meta && gallery) {
    for (const item of gallery) {
      const m = item.media_id ? meta[item.media_id] : undefined;
      const u = m?.e === 'Image' ? m.s?.u : undefined;
      if (u) out.push({ url: decodeUrl(u), ...(item.caption ? { alt: item.caption } : {}) });
    }
    return out;
  }
  const url = str(d.url_overridden_by_dest) ?? str(d.url);
  if (d.post_hint === 'image' && url) return [{ url: decodeUrl(url) }];
  if (url && /\.(jpe?g|png|webp)(\?|$)/i.test(url)) return [{ url: decodeUrl(url) }];
  return out;
}

function isVideo(d: Record<string, unknown>): boolean {
  if (d.is_video === true) return true;
  const hint = str(d.post_hint);
  if (hint === 'hosted:video' || hint === 'rich:video') return true;
  return /(^|\.)(v\.redd\.it|youtube\.com|youtu\.be|streamable\.com)$/i.test(str(d.domain) ?? '');
}

/** One `t3` (link) thing as a post. */
export function redditPost(d: Record<string, unknown>): Post {
  const id = str(d.id) ?? str(d.name) ?? '';
  const permalink = str(d.permalink);
  const stats: Post['stats'] = [];
  const score = num(d.score);
  if (score !== undefined) stats.push(['points', String(score)]);
  const comments = num(d.num_comments);
  if (comments !== undefined) stats.push(['comments', String(comments)]);
  const created = num(d.created_utc);
  const link = str(d.url_overridden_by_dest);
  const selftext = clean(str(d.selftext));
  // a link post's text is its target; the reader needs it to know what the post points at
  const text = selftext || (link && !permalink?.includes(link) && !/\.(jpe?g|png|gif|webp)(\?|$)/i.test(link) ? link : '');
  return {
    platform: 'reddit',
    id,
    url: permalink ? ORIGIN + permalink : `${ORIGIN}/comments/${id}`,
    author: str(d.author) ? `u/${d.author as string}` : undefined,
    community: str(d.subreddit_name_prefixed),
    title: clean(str(d.title)),
    text,
    publishedAt: created !== undefined ? new Date(created * 1000).toISOString() : undefined,
    stats,
    images: images(d),
    video: isVideo(d),
    extraction: 'adapter',
  };
}

export interface RedditListing {
  posts: Post[];
  /** Cursor for the next page, null at the end. */
  after: string | null;
  /** Pinned announcements left out. */
  stickied: number;
}

/** A listing payload; pinned (stickied) posts are left out, since they are not what the listing ranks. */
export function parseRedditListing(json: unknown): RedditListing {
  const data = (json as Thing | undefined)?.data as { children?: Thing[]; after?: string | null } | undefined;
  const posts: Post[] = [];
  let stickied = 0;
  for (const child of data?.children ?? []) {
    if (child.kind !== 't3' || !child.data) continue;
    if (child.data.stickied === true) { stickied++; continue; }
    posts.push(redditPost(child.data));
  }
  return { posts, after: str(data?.after) ?? null, stickied };
}

/** `/comments/<id>.json`: the post and its top-level comments in the order Reddit sorted them. */
export function parseRedditThread(json: unknown, maxComments: number): { post: Post | null; comments: Comment[] } {
  const [postListing, commentListing] = Array.isArray(json) ? (json as Thing[]) : [];
  const postData = ((postListing?.data as { children?: Thing[] } | undefined)?.children ?? [])[0]?.data;
  const comments: Comment[] = [];
  for (const child of (commentListing?.data as { children?: Thing[] } | undefined)?.children ?? []) {
    if (comments.length >= maxComments) break;
    if (child.kind !== 't1' || !child.data) continue;
    const body = clean(str(child.data.body));
    if (!body || body === '[deleted]' || body === '[removed]') continue;
    const score = num(child.data.score);
    comments.push({ author: str(child.data.author) ? `u/${child.data.author as string}` : undefined, text: body, ...(score !== undefined ? { score: `${score} points` } : {}) });
  }
  return { post: postData ? redditPost(postData) : null, comments };
}

/** A reply in the person's inbox to one of their comments or posts. */
export interface RedditReply {
  /** Reddit's id of the reply (`t1_…`), which an answer to it replies to. */
  target: string;
  url: string;
  author: string;
  text: string;
  /** The title of the post the reply is under. */
  title: string;
  createdAtMs: number;
}

/** What the inbox calls a reply to a comment and a reply to a post; mentions and messages are left out. */
const REPLY_TYPES = new Set(['comment_reply', 'post_reply']);

/** The inbox listing's replies to the person's comments and posts, in the order Reddit gave them. */
export function parseRedditInbox(json: unknown): RedditReply[] {
  const out: RedditReply[] = [];
  for (const child of ((json as Thing | undefined)?.data as { children?: Thing[] } | undefined)?.children ?? []) {
    const d = child.data;
    if (child.kind !== 't1' || !d || d.was_comment !== true || !REPLY_TYPES.has(str(d.type) ?? '')) continue;
    const id = str(d.id);
    const context = str(d.context);
    const author = str(d.author);
    const created = num(d.created_utc);
    if (!id || !context?.startsWith('/') || !author || created === undefined) continue;
    out.push({
      target: `t1_${id}`,
      url: ORIGIN + context.replace(/\?.*$/, ''),
      author,
      text: clean(str(d.body)),
      title: clean(str(d.link_title)),
      createdAtMs: created * 1000,
    });
  }
  return out;
}
