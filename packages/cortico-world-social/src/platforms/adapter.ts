/** What every platform adapter offers the World. */
import type { PageSession } from '../browser.ts';
import type { Collector, Deadline } from '../collect.ts';
import type { Comment, PlatformId, Post, SourceKind, Transcript } from '../posts.ts';

export interface BrowseRequest {
  source: SourceKind;
  /** Search terms, account or community; empty for the feed. */
  query: string;
  /** A platform order such as `top` or `latest`; adapters ignore one they do not know. */
  sort?: string;
  /** For ranked lists: hour, day, week, month, year or all. */
  period?: string;
}

export interface PostDetail {
  post: Post;
  comments: Comment[];
}

/** Why a video has no transcript. */
export type NoTranscript = 'no-captions' | 'login' | 'unavailable';

export type TranscriptResult =
  | { kind: 'ok'; transcript: Transcript }
  | { kind: 'none'; reason: NoTranscript; title?: string; url: string };

export interface Adapter {
  id: PlatformId;
  /** Where the person logs in. */
  loginUrl: string;
  /** Cookies that exist only while a login holds, on `domain` (a suffix such as `.reddit.com`). */
  session: { domain: string; cookies: readonly string[] };
  sources: readonly SourceKind[];
  /** Offers posts to `collector` until it is done or the listing ends. */
  list(page: PageSession, req: BrowseRequest, collector: Collector): Promise<void>;
  /** Whether `url` is a page of this platform. */
  owns(url: URL): boolean;
  /** One post with up to `maxComments` comments; null when the page held no post. */
  read(page: PageSession, url: string, maxComments: number, deadline: Deadline): Promise<PostDetail | null>;
  /** Video platforms only. `ref` is a URL or the platform's video id. */
  transcript?(page: PageSession, ref: string, deadline: Deadline): Promise<TranscriptResult>;
  /** The order and period `list` applies for `req`; a receipt names only these. None when absent. */
  applied?(req: BrowseRequest): Pick<BrowseRequest, 'sort' | 'period'>;
  /** A share or short link, which is opened first to reach the post it stands for. */
  shareLink?(url: URL): boolean;
  /** Whether a login holds, for a platform whose cookies cannot tell (it sets the session cookie for guests too). */
  loggedIn?(page: PageSession): Promise<boolean>;
  /** Writing with the browser's login. */
  write: Writer;
}

/** A new post of the person's own: its text, and a title and a community where the platform needs them. */
export interface NewPost {
  text: string;
  title?: string;
  community?: string;
}

/**
 * What the bot can write on a platform, in the person's name with the browser's login. Each call
 * throws `PlatformBlocked` for a missing login, `CommentRefused` with the platform's reason when it
 * turns the text down, and `TimeUp` when it was sent but the platform did not confirm it, so it may be up.
 */
export interface Writer {
  /** What a comment on the post or comment at `url` replies to, as the platform names it; null when the link names neither. */
  replyTarget(url: URL): string | null;
  /** Posts `text` replying to `target`; the comment's link when the platform gives it. */
  comment(page: PageSession, target: string, text: string): Promise<{ link: string | null }>;
  /** The longest comment, counted as `length` counts. */
  commentMax: number;
  /** How the platform counts text against its limits; characters when absent. */
  length?(text: string): number;
  /** The line automatic comments and posts end with while they are marked; `AUTO_LINE` when absent. */
  mark?: string;
  /** New posts of the person's own; absent where the bot writes none. */
  posts?: {
    /** What a post needs besides its text. */
    needs: ReadonlyArray<'title' | 'community'>;
    /** The longest post text, and the longest title where a post needs one. */
    max: number;
    titleMax?: number;
    publish(page: PageSession, post: NewPost): Promise<{ link: string | null }>;
  };
}

/** The handle without a leading @ or `u/`, or the last path segment of a profile URL. */
export function accountName(query: string): string {
  const q = query.trim();
  try {
    const u = new URL(q);
    const seg = u.pathname.split('/').filter(Boolean);
    const at = seg.find((s) => s.startsWith('@'));
    return (at ?? seg[seg[0] === 'user' || seg[0] === 'u' ? 1 : 0] ?? '').replace(/^@/, '');
  } catch {
    return q.replace(/^@/, '').replace(/^u\//, '').replace(/^\/+/, '');
  }
}

export const hostIs = (url: URL, ...domains: string[]): boolean =>
  domains.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));
