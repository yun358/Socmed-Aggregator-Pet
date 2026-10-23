/**
 * What the bot writes on the platforms: comments, and Notes on Substack. A draft waits until the
 * person posts or discards it on the Social media page; the bot has no way to post one. With an
 * automatic switch on, the World queues the post instead, to go out at its time, spaced from the
 * others (`world.ts`). Drafts, the queue, what was posted (the last `POSTED_KEPT`), the watch on the
 * inbox and the day's plan of Notes to write are kept in `social-comments.json` in the deployment's
 * data directory; what was posted counts against the daily limits by its local date.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { localClock } from './autoscroll.ts';
import { PLATFORM_IDS, type PlatformId } from './posts.ts';

/** Drafts that may wait at once. */
export const DRAFTS_MAX = 5;
/** Posted comments and Notes kept for the panel and the daily counts. */
export const POSTED_KEPT = 50;
/** Replies looked at that are remembered, so none is told twice. */
export const SEEN_KEPT = 500;

export type WriteKind = 'comment' | 'note';

export interface CommentDraft {
  id: string;
  platform: PlatformId;
  kind: WriteKind;
  /** The post, comment or Note it replies to, as the bot gave it; empty for a new Note. */
  url: string;
  /**
   * What it replies to as the platform names it: on Reddit `t3_` for a post and `t1_` for a comment,
   * on Substack a post's link or a Note's number; empty for a new Note.
   */
  target: string;
  text: string;
  /** ISO time it was drafted. */
  at: string;
}

/** A post the World sends on its own once `due` has come. */
export interface QueuedPost extends CommentDraft {
  /** The account an answer to a reply answers. */
  to?: string;
  /** ISO time it goes out at the earliest. */
  due: string;
}

export interface PostedComment {
  platform: PlatformId;
  kind: WriteKind;
  url: string;
  /** Its own link, when the platform gave one. */
  link: string | null;
  text: string;
  /** The person changed the draft before posting it. */
  edited: boolean;
  /** Posted without waiting for the person. */
  auto: boolean;
  /** The account an automatic answer to a reply answered. */
  to?: string;
  /** ISO time it was posted. */
  at: string;
}

/** A web address, a Markdown link, or a host on a common domain ending. */
const LINK = /https?:\/\/|www\.|\]\(|\b[a-z0-9-]+\.(com|net|org|io|co|me|ly|gg|xyz|info|biz|app|dev|link|site|shop|top|tv)\b/i;

/** Whether `text` holds a link; a post that does is never sent without the person. */
export const hasLink = (text: string): boolean => LINK.test(text);

/** `platform` turned a post down; `detail` is its reason as it gave it. */
export class CommentRefused extends Error {
  constructor(readonly platform: PlatformId, readonly detail: string) { super(`the post was refused: ${detail}`); }
}

/** The watch on the inbox while automatic replies are on. */
interface Watch {
  /** ISO time automatic replies were turned on; replies from before it get no answer. Null while off. */
  since: string | null;
  /** Ids of the replies looked at, the last `SEEN_KEPT`. */
  seen: string[];
  /** ISO time of the last look at the inbox. */
  checkedAt: string | null;
}

/** One day's plan of the Notes the bot is asked to write on its own. */
export interface Plan {
  /** The local date it is for. */
  date: string;
  /** When, in minutes after local midnight, earliest first. */
  times: number[];
  /** How many of them the bot was asked for, or let pass. */
  told: number;
}

interface Data {
  /** The number of the next draft's or queued post's id. */
  next: number;
  drafts: CommentDraft[];
  queue: QueuedPost[];
  /** Oldest first. */
  posted: PostedComment[];
  watch: Watch;
  plan: Plan | null;
}

const str = (v: unknown): v is string => typeof v === 'string';
const isPlatform = (v: unknown): v is PlatformId => (PLATFORM_IDS as readonly unknown[]).includes(v);
const kindOf = (v: unknown): WriteKind => (v === 'note' ? 'note' : 'comment');

/** A draft read back from the file, or null when it is not one. */
function readDraft(d: Partial<CommentDraft>): CommentDraft | null {
  if (!str(d.id) || !isPlatform(d.platform) || !str(d.url) || !str(d.target) || !str(d.text) || !str(d.at)) return null;
  return { id: d.id, platform: d.platform, kind: kindOf(d.kind), url: d.url, target: d.target, text: d.text, at: d.at };
}

export class CommentStore {
  private data: Data;

  /** `warn` hears of a failed write; the store stays in memory and the next write tries again. */
  constructor(private readonly file: string, private readonly now: () => number = Date.now, private readonly warn: (message: string) => void = () => {}) {
    this.data = this.load();
  }

  private load(): Data {
    const fresh: Data = { next: 1, drafts: [], queue: [], posted: [], watch: { since: null, seen: [], checkedAt: null }, plan: null };
    if (!existsSync(this.file)) return fresh;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Record<keyof Data, unknown>>;
      if (Number.isInteger(raw.next) && (raw.next as number) > 0) fresh.next = raw.next as number;
      for (const d of Array.isArray(raw.drafts) ? raw.drafts as Array<Partial<CommentDraft>> : []) {
        const draft = readDraft(d);
        if (draft) fresh.drafts.push(draft);
      }
      for (const q of Array.isArray(raw.queue) ? raw.queue as Array<Partial<QueuedPost>> : []) {
        const draft = readDraft(q);
        if (draft && str(q.due)) fresh.queue.push({ ...draft, due: q.due, ...(str(q.to) ? { to: q.to } : {}) });
      }
      for (const p of Array.isArray(raw.posted) ? raw.posted as Array<Partial<PostedComment>> : []) {
        if (!isPlatform(p.platform) || !str(p.url) || !str(p.text) || !str(p.at)) continue;
        fresh.posted.push({
          platform: p.platform, kind: kindOf(p.kind), url: p.url, link: str(p.link) ? p.link : null, text: p.text,
          edited: p.edited === true, auto: p.auto === true, ...(str(p.to) ? { to: p.to } : {}), at: p.at,
        });
      }
      const w = (raw.watch ?? {}) as Partial<Record<keyof Watch, unknown>>;
      fresh.watch = {
        since: str(w.since) ? w.since : null,
        seen: Array.isArray(w.seen) ? w.seen.filter(str).slice(-SEEN_KEPT) : [],
        checkedAt: str(w.checkedAt) ? w.checkedAt : null,
      };
      const plan = (raw.plan ?? null) as Partial<Plan> | null;
      if (plan && str(plan.date) && Array.isArray(plan.times) && Number.isInteger(plan.told)) {
        fresh.plan = { date: plan.date, times: plan.times.filter((m): m is number => Number.isInteger(m)), told: plan.told as number };
      }
    } catch {
      // an unreadable file starts again empty; the old one is kept beside it
      try { renameSync(this.file, `${this.file}.unreadable`); } catch { /* left as is */ }
    }
    return fresh;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
      renameSync(tmp, this.file);
    } catch (err) {
      this.warn(`social comments not saved: ${(err as Error).message}`);
    }
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /* ---------- drafts ---------- */

  /** The drafts waiting, oldest first. */
  drafts(): CommentDraft[] {
    return structuredClone(this.data.drafts);
  }

  draft(id: string): CommentDraft | undefined {
    const d = this.data.drafts.find((x) => x.id === id);
    return d && structuredClone(d);
  }

  add(d: Omit<CommentDraft, 'id' | 'at'>): CommentDraft {
    const draft: CommentDraft = { id: `c${this.data.next++}`, ...d, at: this.iso() };
    this.data.drafts.push(draft);
    this.save();
    return structuredClone(draft);
  }

  /** Takes a draft away; the draft, or undefined when there was none. */
  remove(id: string): CommentDraft | undefined {
    const i = this.data.drafts.findIndex((x) => x.id === id);
    if (i < 0) return undefined;
    const [d] = this.data.drafts.splice(i, 1);
    this.save();
    return d;
  }

  /* ---------- the queue ---------- */

  /** The posts queued, the next to go out first. */
  queued(): QueuedPost[] {
    return structuredClone([...this.data.queue].sort((a, b) => a.due.localeCompare(b.due)));
  }

  enqueue(q: Omit<QueuedPost, 'id' | 'at'>): QueuedPost {
    const post: QueuedPost = { id: `q${this.data.next++}`, ...q, at: this.iso() };
    this.data.queue.push(post);
    this.save();
    return structuredClone(post);
  }

  /** Takes a post off the queue; the post, or undefined when it was not queued. */
  unqueue(id: string): QueuedPost | undefined {
    const i = this.data.queue.findIndex((x) => x.id === id);
    if (i < 0) return undefined;
    const [q] = this.data.queue.splice(i, 1);
    this.save();
    return q;
  }

  /** When the last post of `kind` on `platform` went out, or the last one queued goes out; 0 for none. */
  lastAt(platform: PlatformId, kind: WriteKind): number {
    const times = [
      ...this.data.posted.filter((p) => p.platform === platform && p.kind === kind).map((p) => Date.parse(p.at)),
      ...this.data.queue.filter((q) => q.platform === platform && q.kind === kind).map((q) => Date.parse(q.due)),
    ];
    return times.length ? Math.max(...times) : 0;
  }

  /* ---------- what was posted ---------- */

  /** Records a post that went out, and takes away the draft or queued post `id` it was, if any. */
  record(posted: Omit<PostedComment, 'at'>, id?: string): void {
    this.data.drafts = this.data.drafts.filter((x) => x.id !== id);
    this.data.queue = this.data.queue.filter((x) => x.id !== id);
    this.data.posted.push({ ...posted, at: this.iso() });
    this.data.posted = this.data.posted.slice(-POSTED_KEPT);
    this.save();
  }

  /** What was posted, of `kind` when given, newest first. */
  posted(limit = POSTED_KEPT, kind?: WriteKind): PostedComment[] {
    return structuredClone(this.data.posted.filter((p) => !kind || p.kind === kind).slice(-limit).reverse());
  }

  private isToday(iso: string, timezone: string): boolean {
    return localClock(Date.parse(iso), timezone).date === localClock(this.now(), timezone).date;
  }

  /** Posts of `kind` posted on today's local date in `timezone`. */
  today(timezone: string, kind: WriteKind = 'comment'): number {
    return this.data.posted.filter((p) => p.kind === kind && this.isToday(p.at, timezone)).length;
  }

  /** Posts of `kind` posted today, and queued to go out today. */
  todayWithQueued(timezone: string, kind: WriteKind): number {
    return this.today(timezone, kind) + this.data.queue.filter((q) => q.kind === kind && this.isToday(q.due, timezone)).length;
  }

  /** Automatic answers posted or queued to `account` on today's local date in `timezone`. */
  answeredToday(account: string, timezone: string): number {
    const to = account.toLowerCase();
    return this.data.posted.filter((p) => p.to?.toLowerCase() === to && this.isToday(p.at, timezone)).length
      + this.data.queue.filter((q) => q.to?.toLowerCase() === to && this.isToday(q.due, timezone)).length;
  }

  /* ---------- the watch on the inbox ---------- */

  /** When automatic replies were turned on: now, on the first look after they were. */
  watchSince(): string {
    if (!this.data.watch.since) {
      this.data.watch.since = this.iso();
      this.save();
    }
    return this.data.watch.since;
  }

  /** Automatic replies are off: the next time they are on, replies from before then get no answer. */
  stopWatching(): void {
    if (!this.data.watch.since) return;
    this.data.watch.since = null;
    this.save();
  }

  get checkedAt(): string | null {
    return this.data.watch.checkedAt;
  }

  /** Whether the reply `target` was looked at already. */
  seen(target: string): boolean {
    return this.data.watch.seen.includes(target);
  }

  /** Remembers the replies looked at now, and when. */
  looked(targets: readonly string[]): void {
    const seen = this.data.watch.seen.filter((x) => !targets.includes(x));
    this.data.watch.seen = [...seen, ...targets].slice(-SEEN_KEPT);
    this.data.watch.checkedAt = this.iso();
    this.save();
  }

  /* ---------- the day's plan of Notes ---------- */

  /** The plan for `date` with `count` times, made with `pick` when there is none like it. */
  plan(date: string, count: number, pick: () => number[]): Plan {
    const p = this.data.plan;
    if (!p || p.date !== date || p.times.length !== count) {
      this.data.plan = { date, times: pick(), told: p?.date === date ? p.told : 0 };
      this.save();
    }
    return structuredClone(this.data.plan!);
  }

  /** `told` of today's planned Notes were asked for or let pass. */
  told(told: number): void {
    if (!this.data.plan || this.data.plan.told === told) return;
    this.data.plan.told = told;
    this.save();
  }
}
