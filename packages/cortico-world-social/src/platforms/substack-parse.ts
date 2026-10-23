/**
 * Substack's JSON read into posts: a publication's archive (`/api/v1/archive`), one post
 * (`/api/v1/posts/<slug>`) and its comments (`/api/v1/post/<id>/comments`), the reader feeds
 * (`/api/v1/reader/feed`, `/api/v1/reader/feed/profile/<user id>`), whose items are posts and Notes,
 * the categories and a category's leaderboard of publications, and the account logged in; and what
 * a query names. Imports nothing that runs only in Node, so the panel reads `publicationAddress` too.
 */
import { clean, type Comment, type Post } from '../posts.ts';
import { hostIs } from './adapter.ts';

export const SUBSTACK_ORIGIN = 'https://substack.com';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The character an HTML entity stands for; one this does not know stays as written. */
function entity(m: string, e: string): string {
  const named = ENTITIES[e.toLowerCase()];
  if (named) return named;
  const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : /^#\d+$/.test(e) ? Number(e.slice(1)) : NaN;
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
}

/** The text of a post's HTML body: a paragraph, heading or list item to a line. */
export function htmlText(html: string): string {
  return clean(html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|h[1-6]|li|blockquote|div|pre|figcaption)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, entity));
}

/** Likes, comments and restacks as a post's stats. */
function stats(d: Obj, replies: 'comments' | 'replies'): Post['stats'] {
  const out: Post['stats'] = [];
  const likes = num(d.reaction_count);
  if (likes !== undefined) out.push(['likes', String(likes)]);
  const comments = num(d.comment_count) ?? num(d.children_count);
  if (comments !== undefined) out.push([replies, String(comments)]);
  const restacks = num(d.restacks);
  if (restacks !== undefined) out.push(['restacks', String(restacks)]);
  return out;
}

/**
 * One post of a publication at `origin`, from its archive (the start of its text) or its post
 * endpoint (all of it), linked at `origin`. A podcast or video post is a video; a paid post shows only
 * its start.
 */
export function substackPost(d: Obj, origin: string): Post {
  const slug = str(d.slug);
  const bylines = Array.isArray(d.publishedBylines) ? d.publishedBylines as Obj[] : [];
  const body = str(d.body_html) ? htmlText(d.body_html as string) : clean(str(d.truncated_body_text) ?? str(d.description));
  return {
    platform: 'substack',
    id: String(num(d.id) ?? slug ?? ''),
    url: slug ? `${origin}/p/${slug}` : str(d.canonical_url) ?? origin,
    author: str(bylines[0]?.name),
    title: clean(str(d.title)),
    text: [clean(str(d.subtitle)), body].filter(Boolean).join('\n'),
    publishedAt: str(d.post_date),
    stats: stats(d, 'comments'),
    images: [],
    video: d.type === 'podcast' || d.type === 'video' || Boolean(d.videoUpload) || Boolean(d.podcast_url),
    extraction: 'adapter',
  };
}

/** An archive page: its posts in the order Substack gave them. */
export function parseSubstackArchive(json: unknown, origin: string): Post[] {
  return (Array.isArray(json) ? json as unknown[] : []).map(obj).filter((d): d is Obj => !!d && (num(d.id) !== undefined || !!str(d.slug))).map((d) => substackPost(d, origin));
}

/** A post's comments, the top-level ones in the order Substack sorted them. */
export function parseSubstackComments(json: unknown, maxComments: number): Comment[] {
  const list = Array.isArray(obj(json)?.comments) ? (obj(json)!.comments as unknown[]) : Array.isArray(json) ? json as unknown[] : [];
  const out: Comment[] = [];
  for (const c of list.map(obj)) {
    if (out.length >= maxComments) break;
    const text = clean(str(c?.body));
    if (!c || !text || c.deleted === true) continue;
    const likes = num(c.reaction_count) ?? Object.values(obj(c.reactions) ?? {}).reduce<number>((n, v) => n + (num(v) ?? 0), 0);
    out.push({ author: str(c.name) ?? str(c.handle), text, ...(likes ? { score: `${likes} likes` } : {}) });
  }
  return out;
}

/** A Note's link, by its author's handle and its id. */
export const noteUrl = (handle: string | undefined, id: number): string => (handle ? `${SUBSTACK_ORIGIN}/@${handle}/note/c-${id}` : `${SUBSTACK_ORIGIN}/note/c-${id}`);

/** One Note from a feed item's `comment`. */
function substackNote(c: Obj, user?: Obj): Post {
  const id = num(c.id) ?? 0;
  const handle = str(c.handle) ?? str(user?.handle);
  return {
    platform: 'substack',
    id: `c-${id}`,
    url: noteUrl(handle, id),
    author: str(c.name) ?? str(user?.name),
    title: undefined,
    text: clean(str(c.body)),
    publishedAt: str(c.date),
    stats: stats(c, 'replies'),
    images: [],
    video: false,
    extraction: 'adapter',
  };
}

/**
 * The base address of a publication: its substack.com one, which leads to its own domain when it has
 * one and keeps its links readable here (`SUBSTACK.owns`); else its own domain.
 */
export function publicationOrigin(p: Obj | undefined): string | undefined {
  const sub = str(p?.subdomain);
  if (sub) return `https://${sub}.substack.com`;
  const domain = str(p?.custom_domain);
  return domain ? `https://${domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}` : undefined;
}

/** A reader feed's posts and Notes, in its order; restacks and other items are left out. */
export function parseSubstackFeed(json: unknown): Post[] {
  const out: Post[] = [];
  for (const item of (Array.isArray(obj(json)?.items) ? obj(json)!.items as unknown[] : []).map(obj)) {
    if (!item) continue;
    const key = str(item.entity_key) ?? '';
    const comment = obj(item.comment);
    if ((item.type === 'comment' || key.startsWith('c-')) && comment && str(comment.body)) {
      const users = obj(item.context)?.users;
      out.push(substackNote(comment, Array.isArray(users) ? obj(users[0]) : undefined));
      continue;
    }
    const post = obj(item.post);
    if ((item.type === 'post' || key.startsWith('p-')) && post) {
      const origin = publicationOrigin(obj(item.publication)) ?? publicationOrigin(obj(post.publication)) ?? SUBSTACK_ORIGIN;
      out.push({ ...substackPost(post, origin), community: str(obj(item.publication)?.name) });
    }
  }
  return out;
}

export interface SubstackCategory {
  id: number;
  name: string;
  slug?: string;
}

/** The categories Substack lists. */
export function parseSubstackCategories(json: unknown): SubstackCategory[] {
  return (Array.isArray(json) ? json as unknown[] : []).map(obj)
    .filter((c): c is Obj => num(c?.id) !== undefined && !!str(c?.name))
    .map((c) => ({ id: c.id as number, name: c.name as string, ...(str(c.slug) ? { slug: c.slug as string } : {}) }));
}

/** The category `query` names, by its name or slug whatever the case and punctuation, `&` read as and. */
export function findCategory(categories: readonly SubstackCategory[], query: string): SubstackCategory | undefined {
  const key = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  const q = key(query);
  if (!q) return undefined;
  return categories.find((c) => key(c.name) === q || (c.slug && key(c.slug) === q))
    ?? categories.find((c) => key(c.name).includes(q) || q.includes(key(c.name)));
}

/** A leaderboard's publications (`items[].publication`), best placed first: each one's base address and name. */
export function parseSubstackLeaderboard(json: unknown): Array<{ origin: string; name: string }> {
  const out: Array<{ origin: string; name: string }> = [];
  for (const item of (Array.isArray(obj(json)?.items) ? obj(json)!.items as unknown[] : []).map(obj)) {
    const p = obj(item?.publication);
    const origin = publicationOrigin(p);
    if (origin) out.push({ origin, name: str(p?.name) ?? origin });
  }
  return out;
}

/** The account logged in, from `/api/v1/user/profile/self`, or a person's from `/api/v1/user/<handle>/public_profile`; null when the answer names none. */
export function parseSubstackSelf(json: unknown): { id: number; handle: string; name: string } | null {
  const d = obj(json);
  const id = num(d?.id);
  if (id === undefined) return null;
  return { id, handle: str(d?.handle) ?? '', name: str(d?.name) ?? '' };
}

const isSubstackCom = (u: URL): boolean => u.hostname === 'substack.com' || u.hostname === 'www.substack.com';
const asUrl = (q: string): URL | null => {
  try {
    return new URL(/^https?:\/\//i.test(q) ? q : `https://${q}`);
  } catch {
    return null;
  }
};

/**
 * A publication's base address from what names it: its name, `name.substack.com`, its own domain,
 * or a link to it or one of its posts. Null for `me`, an `@handle` and a substack.com link, which name
 * a person, and for what is no address.
 */
export function publicationAddress(query: string): string | null {
  const q = query.trim();
  if (!q || q.toLowerCase() === 'me' || q.startsWith('@')) return null;
  const u = asUrl(q);
  if (!u || isSubstackCom(u) || !/^[a-z0-9.-]+$/.test(u.hostname)) return null;
  return u.hostname.includes('.') ? u.origin : `https://${u.hostname}.substack.com`;
}

/** The person a query names by handle: `@handle`, or a `substack.com/@handle` link. */
export function profileHandle(query: string): string | null {
  const q = query.trim();
  const at = /^@([\w.-]+)$/.exec(q)?.[1];
  if (at) return at;
  const u = /^(https?:\/\/)?(www\.)?substack\.com\//i.test(q) ? asUrl(q) : null;
  return (u && isSubstackCom(u) && /^\/@([\w.-]+)/.exec(u.pathname)?.[1]) || null;
}

/** Whether `origin` is a substack.com address, whose post links `SUBSTACK.owns`. */
export const onSubstack = (origin: string): boolean => {
  const u = asUrl(origin);
  return !!u && hostIs(u, 'substack.com');
};

/** A Note's body as Substack's editor stores it: a paragraph to a line, an empty line an empty paragraph. */
export function noteDoc(text: string): Obj {
  return {
    type: 'doc',
    attrs: { schemaVersion: 'v1' },
    content: text.split('\n').map((line) => (line.trim() ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
  };
}

/** Inline Markdown (bold, italics, links) as the editor's text nodes and marks. */
function inline(text: string): Obj[] {
  const out: Obj[] = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index! > at) out.push({ type: 'text', text: text.slice(at, m.index) });
    if (m[1]) out.push({ type: 'text', text: m[1], marks: [{ type: 'link', attrs: { href: m[2] } }] });
    else if (m[3]) out.push({ type: 'text', text: m[3], marks: [{ type: 'strong' }] });
    else out.push({ type: 'text', text: m[4] ?? m[5], marks: [{ type: 'em' }] });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ type: 'text', text: text.slice(at) });
  return out;
}

/**
 * A post's body in Markdown as the editor's document: paragraphs, `#`–`###` headings, `-` and `1.`
 * lists, `>` quotes, and bold, italics and links within them.
 */
export function markdownDoc(markdown: string): Obj {
  const content: Obj[] = [];
  const blocks = markdown.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    const heading = /^(#{1,3})\s+(.*)$/.exec(block);
    if (heading && lines.length === 1) {
      content.push({ type: 'heading', attrs: { level: heading[1]!.length }, content: inline(heading[2]!) });
    } else if (lines.every((l) => /^[-*]\s+/.test(l)) || lines.every((l) => /^\d+[.)]\s+/.test(l))) {
      const ordered = /^\d/.test(lines[0]!);
      content.push({
        type: ordered ? 'ordered_list' : 'bullet_list',
        content: lines.map((l) => ({ type: 'list_item', content: [{ type: 'paragraph', content: inline(l.replace(/^([-*]|\d+[.)])\s+/, '')) }] })),
      });
    } else if (lines.every((l) => l.startsWith('>'))) {
      content.push({ type: 'blockquote', content: [{ type: 'paragraph', content: inline(lines.map((l) => l.replace(/^>\s?/, '')).join(' ')) }] });
    } else {
      content.push({ type: 'paragraph', content: inline(lines.join(' ')) });
    }
  }
  return { type: 'doc', content };
}
