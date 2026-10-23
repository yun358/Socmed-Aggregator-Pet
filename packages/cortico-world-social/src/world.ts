/**
 * The social media World: the bot reads platforms in its own browser (`browser.ts`) through one
 * adapter per platform (`platforms/`), within limits the person sets per request. A request is one
 * turn of the bot: what every `social_*` read in that turn used is added up and checked against
 * `maxPosts` and `maxSec`, and starts again from nothing when the turn ends. The daily autoscroll
 * runs here, outside any turn, and tells the bot when a run's posts are ready, once it is idle.
 * Comments the bot writes wait for the person on the panel, which alone posts them, unless the
 * person turned on automatic comments or replies; then they are posted at once (`comments.ts`). While
 * automatic replies are on, the inbox is looked at every `REPLY_CHECK_MS` and new replies are told.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { BlobInput, RunPhase, StoragePart, ToolDef, ToolOutcome, TriggerMode, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { DeepPartial } from 'cortico/world.ts';
import { DigestStore, digestId, dueJobs, jobKey, localClock, type Digest } from './autoscroll.ts';
import { BrowserBusy, BrowserMissing, Interrupted, LoginWindowOpen, SocialBrowser, TimeUp, type PageLimits, type PageSession } from './browser.ts';
import { Collector, Deadline, PlatformBlocked, type StopReason } from './collect.ts';
import { CommentRefused, CommentStore, DRAFTS_MAX, hasLink, type CommentDraft, type PostedComment } from './comments.ts';
import { COMMENTS_PER_DAY_CAP, MAX_JOBS, JOB_POSTS_CAP, MAX_POSTS_CAP, MAX_SEC_CAP, SOCIAL_ID, SOURCE_KINDS, parseJobs, socialConfigGroup, type AutoscrollJob, type ImageMode, type SocialConfigSection } from './config.ts';
import { findBrowser } from './find-browser.ts';
import { socialText, type SocialText } from './i18n/index.ts';
import { readImages } from './images.ts';
import { Lifetime } from './lifetime.ts';
import { MODEL_TEXT, type Limits, type ModelLanguage, type ModelText } from './model-text.ts';
import { Ocr, ocrLanguagesFor } from './ocr.ts';
import { ADAPTERS, platformOf, type Adapter, type BrowseRequest, type TranscriptResult } from './platforms/index.ts';
import { bilibiliVideoId } from './platforms/bilibili-parse.ts';
import { AUTO_NOTE, BOT_COMMENT_MAX, REDDIT_COMMENT_MAX, postRedditComment, redditInbox, redditReplyTarget } from './platforms/reddit.ts';
import { youtubeVideoId } from './platforms/youtube-parse.ts';
import { PLATFORM_IDS, VIDEO_PLATFORMS, type PlatformId, type Post, type Transcript } from './posts.ts';
import { COMMENT_TEXT_MAX, localStamp, oneLine, renderPage, renderPost, renderTranscript } from './render.ts';
import { COMMENTS_DEFAULT, COMMENTS_MAX, SOCIAL_TOOL_DECLS } from './tools.ts';

const ENV_PROMPT_FILES: Record<ModelLanguage, string> = {
  zh: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('./ENV_PROMPT.en.md', import.meta.url)),
};

/** How often the autoscroll schedule is looked at. */
const SCHEDULE_MS = 30_000;
/** First look after start, once Core has settled. */
const FIRST_LOOK_MS = 20_000;
/** Characters of a digest page. */
const DIGEST_PAGE_CHARS = 8000;
/** Characters of each post's text on a digest page. */
const DIGEST_TEXT_MAX = 600;
/** Characters of a post's text in `social_read`. */
const READ_TEXT_MAX = 20000;
/** Time a page-based login check may take. */
const LOGIN_CHECK_MS = 20_000;
/** Transcripts kept for `from_sec` follow-ups without reloading the video. */
const TRANSCRIPT_CACHE = 4;
/** Time posting one comment may take. */
const POST_MS = 30_000;
/** Posted comments the panel lists. */
const POSTED_SHOWN = 10;
/** How often the inbox is looked at while automatic replies are on. */
export const REPLY_CHECK_MS = 5 * 60_000;
/** Time a look at the inbox may take. */
const INBOX_MS = 20_000;
/** How long after the bot is told of a reply its answer to it is posted at once. */
export const REPLY_WAIT_MS = 60 * 60_000;
/** Replies older than this get no answer. */
export const REPLY_MAX_AGE_MS = 24 * 60 * 60_000;
/** Automatic answers to one account in one day; past them an answer waits for the person. */
export const REPLIES_PER_ACCOUNT = 2;
/** Accounts whose replies get no automatic answer, lowercased: Reddit's moderation bot, and the deleted. */
const NO_ANSWER = new Set(['automoderator', '[deleted]']);

export interface SocialWorldOptions {
  /** The live `worlds.social` section; every key is read at use. */
  cfg: SocialConfigSection;
  timezone: string;
  /** The deployment's data directory, shared with Core and the other Worlds. */
  dataDir: string;
  /** Where OCR language data is kept. */
  ocrDir: string;
  persist(patch: DeepPartial<SocialConfigSection>): void;
  /** The language of what the bot reads; Chinese when absent. */
  modelLanguage?(): ModelLanguage;
  /** The app language: OCR languages follow it. */
  language?(): Language;
  /** Brings up the panel where a new draft waits for the person. */
  showDrafts?(): void;
  /** Tests lend a browser and OCR of their own. */
  browser?: SocialBrowser;
  ocr?: Ocr;
  now?(): number;
}

/** A panel's view of the World, for the settings window. */
export interface SocialPanelState {
  config: {
    maxPosts: number; maxSec: number; images: ImageMode; maxTranscriptChars: number; showBrowser: boolean; browserFile: string;
    platforms: Record<PlatformId, boolean>;
    autoscroll: { enabled: boolean; maxMinutes: number };
    comments: { enabled: boolean; maxPerDay: number; auto: boolean; autoReply: boolean; sign: boolean };
  };
  jobs: AutoscrollJob[];
  /** The browser that will be run, null when none is found. */
  browser: string | null;
  logins: Partial<Record<PlatformId, boolean>>;
  checkingLogins: boolean;
  lifetime: ReturnType<Lifetime['snapshot']>;
  digests: ReturnType<DigestStore['list']>;
  /** The job running now. */
  running: string | null;
  comments: {
    drafts: CommentDraft[];
    /** The last posted, newest first. */
    posted: PostedComment[];
    /** Posted today, by the local date. */
    today: number;
    /** Drafts being posted now. */
    posting: string[];
    /** The last look at the inbox for automatic replies, as an ISO time. */
    checkedAt: string | null;
  };
  caps: { maxPosts: number; maxSec: number; jobPosts: number; jobs: number; commentsPerDay: number; replyCheckMin: number; repliesPerAccount: number };
}

/** What reading a call's images gave: the images to attach, and why OCR could not run, if it could not. */
interface ImagesFound {
  blobs: BlobInput[];
  ocrFailure: string | null;
}

/** How a listing went: why it stopped, and the block or error that cut it short after some posts. */
interface Gathered extends ImagesFound {
  stopped: StopReason;
  cut: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** An error's first line without terminal colors; Playwright adds a call log on further lines. */
const firstLine = (err: unknown): string => String((err as Error)?.message ?? err).replace(/\u001b\[[\d;]*m/g, '').split('\n')[0].trim();
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined);

export class SocialWorld implements World {
  readonly id = SOCIAL_ID;
  private host: WorldHost | null = null;
  private schedule: NodeJS.Timeout | null = null;
  private firstLook: NodeJS.Timeout | null = null;
  private phase: RunPhase['state'] = 'idle';
  /** What this turn's reads used. */
  private turn = { posts: 0, ms: 0, transcripts: new Set<string>() };
  private logins: Partial<Record<PlatformId, boolean>> = {};
  private checkingLogins: Promise<void> | null = null;
  private running: string | null = null;
  /** Set from `stop` to the next `start`: a job it cuts off is neither saved nor told. */
  private stopping = false;
  /** Events held until the bot is idle. */
  private held: Array<() => Promise<void>> = [];
  private transcripts = new Map<string, Transcript>();
  private readonly browser: SocialBrowser;
  private readonly ocr: Ocr;
  private readonly lifetime: Lifetime;
  private readonly digests: DigestStore;
  private readonly comments: CommentStore;
  /** Drafts being posted now; posting or discarding one of them is refused until that ends. */
  private readonly posting = new Set<string>();
  /** Replies the bot was told of, by the id an answer replies to, with their author and when it was told. */
  private readonly awaiting = new Map<string, { author: string; at: number }>();
  private checkingReplies: Promise<void> | null = null;
  private lastReplyLook = 0;

  constructor(private readonly opts: SocialWorldOptions) {
    this.browser = opts.browser ?? new SocialBrowser({
      profileDir: this.profileDir,
      executable: () => findBrowser(opts.cfg.browserFile),
      configured: () => opts.cfg.browserFile,
      showWindow: () => opts.cfg.showBrowser,
      warn: (m) => this.host?.log.warn(m),
    });
    this.ocr = opts.ocr ?? new Ocr({ dataDir: opts.ocrDir });
    this.lifetime = new Lifetime(join(opts.dataDir, `${SOCIAL_ID}-lifetime.json`), this.now, (m) => this.host?.log.warn(m));
    this.digests = new DigestStore(join(opts.dataDir, `${SOCIAL_ID}-digests`));
    this.comments = new CommentStore(join(opts.dataDir, `${SOCIAL_ID}-comments.json`), this.now, (m) => this.host?.log.warn(m));
  }

  private get cfg(): SocialConfigSection { return this.opts.cfg; }
  private get profileDir(): string { return join(this.opts.dataDir, `${SOCIAL_ID}-browser`); }
  private get language(): ModelLanguage { return this.opts.modelLanguage?.() ?? 'zh'; }
  private get t(): ModelText { return MODEL_TEXT[this.language]; }
  private readonly now = (): number => this.opts.now?.() ?? Date.now();

  /* ---------- lifecycle ---------- */

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopping = false;
    this.firstLook = setTimeout(() => void this.look(), FIRST_LOOK_MS);
    this.schedule = setInterval(() => void this.look(), SCHEDULE_MS);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.firstLook) clearTimeout(this.firstLook);
    if (this.schedule) clearInterval(this.schedule);
    this.firstLook = this.schedule = null;
    this.held = [];
    this.lifetime.flush();
    await this.browser.stop();
    await this.ocr.release();
    this.host = null;
  }

  onTurnEnded(): void {
    this.turn = { posts: 0, ms: 0, transcripts: new Set() };
  }

  onRunPhase(phase: RunPhase): void {
    this.phase = phase.state;
    if (phase.state === 'idle' && this.held.length) queueMicrotask(() => void this.release());
  }

  /** Pushes `push` now when the bot is idle, else when it next is. */
  private whenIdle(push: () => Promise<void>): void {
    this.held.push(push);
    if (this.phase === 'idle') void this.release();
  }

  private async release(): Promise<void> {
    const held = this.held;
    this.held = [];
    for (const push of held) await push().catch((err: Error) => this.host?.log.warn(`social event not sent: ${err.message}`));
  }

  private async push(type: string, text: string, trigger: TriggerMode, origin: 'internal' | 'external' = 'external'): Promise<void> {
    await this.host?.pushEvent({ type, source: this.id, senderKey: this.id, ts: nowIso(this.opts.timezone), text, origin }, { trigger });
  }

  /* ---------- limits ---------- */

  private limits(): Limits {
    return { posts: this.turn.posts, maxPosts: this.cfg.maxPosts, sec: Math.round(this.turn.ms / 1000), maxSec: this.cfg.maxSec };
  }

  private left(): { posts: number; ms: number } {
    return { posts: Math.max(0, this.cfg.maxPosts - this.turn.posts), ms: Math.max(0, this.cfg.maxSec * 1000 - this.turn.ms) };
  }

  private spend(platform: PlatformId, ms: number, posts: number, transcripts = 0): void {
    this.turn.posts += posts;
    this.turn.ms += ms;
    this.lifetime.add(platform, ms, { posts, transcripts });
  }

  /* ---------- tools ---------- */

  tools(): ToolDef[] {
    const handlers: Record<string, (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string | ToolOutcome>> = {
      social_browse: (a, s) => this.browse(a, s),
      social_read: (a, s) => this.read(a, s),
      social_transcript: (a, s) => this.transcript(a, s),
      social_login: (a) => this.login(a),
      social_comment: (a, s) => this.comment(a, s),
      social_stats: async () => this.stats(),
      social_digest: async (a) => this.digest(a),
    };
    return SOCIAL_TOOL_DECLS.map((decl) => ({
      ...decl,
      interruptible: true,
      handler: async (args, ctx) => {
        try {
          return await handlers[decl.name]!(args, ctx.signal);
        } catch (err) {
          return { text: this.t.failed(decl.name, this.why(err)), failed: true };
        }
      },
    }));
  }

  /** A failure as the receipt states it. */
  private why(err: unknown): string {
    const t = this.t;
    if (err instanceof BrowserMissing) return err.configured ? t.noBrowserAt(err.configured) : t.noBrowser;
    if (err instanceof BrowserBusy) return t.busy(err.pages);
    if (err instanceof LoginWindowOpen) return t.loginWindowOpen;
    if (err instanceof PlatformBlocked) return t.blocked(t.platform[err.platform], err.platform, err.kind, err.detail);
    if (err instanceof CommentRefused) return t.commentRefused(err.detail);
    return t.error(firstLine(err));
  }

  /** A platform argument the person allows, or the receipt that refuses it. */
  private platformArg(tool: string, v: unknown): { platform: PlatformId } | { refusal: string } {
    const platform = PLATFORM_IDS.find((p) => p === v);
    if (!platform) return { refusal: this.t.notRun(tool, this.t.error(`unknown platform ${String(v)}`)) };
    if (!this.cfg.platforms[platform]?.enabled) return { refusal: this.t.notRun(tool, this.t.platformOff(this.t.platform[platform])) };
    return { platform };
  }

  private pageLimits(deadline: Deadline, signal?: AbortSignal): PageLimits {
    return { signal, timeLeft: () => deadline.leftMs };
  }

  /**
   * Reads the images of `posts` as the image setting says, adding the images to attach to
   * `found.blobs` as they are read, so an interruption keeps those the posts already name.
   */
  private async images(page: PageSession, posts: Post[], platform: PlatformId, mode: ImageMode, deadline: Deadline, found: ImagesFound): Promise<void> {
    if (mode === 'skip' || !posts.some((p) => p.images.length)) return;
    const { blobs } = found;
    found.ocrFailure = await readImages(page, posts, {
      mode,
      deadline,
      ocr: this.ocr,
      languages: ocrLanguagesFor(this.opts.language?.() ?? 'zh', platform),
      accepts: (mime) => this.host?.modelFacts.accepts(mime) ?? false,
      attach: (bytes, mime, post, image) => {
        blobs.push({ bytes, mime, name: `${platform}-post-${post}-image-${image}.${mime.split('/')[1] ?? 'img'}`, fallbackText: this.t.attachedCaption(blobs.length + 1, post, image) });
        return blobs.length;
      },
    });
  }

  /**
   * Lists posts into `collector` and reads their images. An interruption, the time running out, or a
   * block or error after some posts were read ends the gathering with what it has; `stopped` and
   * `cut` say which.
   */
  private async gather(adapter: Adapter, req: BrowseRequest, collector: Collector, mode: ImageMode, signal?: AbortSignal): Promise<Gathered> {
    let interrupted = false;
    let cut: unknown = null;
    const found: ImagesFound = { blobs: [], ocrFailure: null };
    await this.browser.withPage(async (page) => {
      try {
        await adapter.list(page, req, collector);
      } catch (err) {
        // an operation the interruption cut off throws its own error
        if (err instanceof Interrupted || signal?.aborted) interrupted = true;
        else if (!(err instanceof TimeUp)) {
          if (!collector.posts.length) throw err;
          cut = err;
        }
      }
      if (interrupted) return;
      try {
        await this.images(page, collector.posts, adapter.id, mode, collector.deadline, found);
      } catch (err) {
        if (err instanceof Interrupted || signal?.aborted) interrupted = true;
        else if (!(err instanceof TimeUp)) throw err;
      }
    }, this.pageLimits(collector.deadline, signal));
    return { stopped: collector.stopReason(interrupted), ...found, cut };
  }

  private async browse(args: Record<string, unknown>, signal?: AbortSignal): Promise<string | ToolOutcome> {
    const t = this.t;
    const picked = this.platformArg('social_browse', args.platform);
    if ('refusal' in picked) return picked.refusal;
    const { platform } = picked;
    const adapter = ADAPTERS[platform];
    const source = SOURCE_KINDS.find((k) => k === args.source);
    if (!source || !adapter.sources.includes(source)) return t.notRun('social_browse', t.noSource(t.platform[platform], source ?? 'feed', [...adapter.sources]));
    const query = str(args.query).trim();
    if (source !== 'feed' && !query) return t.notRun('social_browse', t.needQuery);
    const left = this.left();
    if (left.posts <= 0 || left.ms <= 0) return t.notRun('social_browse', t.limitUsed(this.limits()));
    const want = Math.min(left.posts, Math.max(1, int(args.max_posts) ?? left.posts));
    const req: BrowseRequest = { source, query, sort: str(args.sort) || undefined, period: str(args.period) || undefined };
    const collector = new Collector(platform, want, this.cfg.images, new Deadline(left.ms, this.now));
    let result: Gathered;
    try {
      result = await this.gather(adapter, req, collector, this.cfg.images, signal);
    } finally {
      this.spend(platform, collector.deadline.elapsedMs, collector.posts.length);
    }
    const order = adapter.applied?.(req) ?? {};
    const what = t.source(source, query, order.sort, order.period);
    const head = t.browseHead(t.platform[platform], what, t.posts(collector.posts.length, VIDEO_PLATFORMS.has(platform)), t.duration(collector.deadline.elapsedMs));
    return { text: [head, ...this.summary(collector, result), ...this.listing(collector.posts)].join('\n\n'), blobs: result.blobs };
  }

  /** The lines after a listing's head: what was left out, why it stopped, readers and limits. */
  private summary(collector: Collector, r: Omit<Gathered, 'blobs'>, withLimits = true): string[] {
    const t = this.t;
    const left = [
      collector.skipped.video ? t.leftVideo(collector.skipped.video) : '',
      collector.skipped.image ? t.leftImage(collector.skipped.image) : '',
      collector.skipped.ad ? t.leftAd(collector.skipped.ad) : '',
    ].filter(Boolean);
    const lines = [
      [left.length ? t.leftOut(left) : '', r.cut ? this.why(r.cut) : t.stopped[r.stopped]].filter(Boolean).join(' '),
      collector.generic ? t.generic : '',
      r.ocrFailure ? t.ocrFailed(r.ocrFailure) : '',
      withLimits ? t.used(this.limits()) : '',
    ];
    return [lines.filter(Boolean).join('\n')];
  }

  private listing(posts: Post[]): string[] {
    if (!posts.length) return [this.t.nothing];
    return posts.map((p, i) => renderPost(this.t, i + 1, p, this.opts.timezone));
  }

  private async read(args: Record<string, unknown>, signal?: AbortSignal): Promise<string | ToolOutcome> {
    const t = this.t;
    const url = str(args.url).trim();
    const owner = platformOf(url);
    if (!owner) return t.notRun('social_read', t.notPlatformUrl);
    const picked = this.platformArg('social_read', owner);
    if ('refusal' in picked) return picked.refusal;
    const { platform } = picked;
    const left = this.left();
    if (left.posts <= 0 || left.ms <= 0) return t.notRun('social_read', t.limitUsed(this.limits()));
    const comments = Math.min(COMMENTS_MAX, Math.max(0, int(args.comments) ?? COMMENTS_DEFAULT));
    const deadline = new Deadline(left.ms, this.now);
    let detail: Awaited<ReturnType<Adapter['read']>> = null;
    const images: ImagesFound = { blobs: [], ocrFailure: null };
    const adapter = ADAPTERS[platform];
    let cut: Interrupted | TimeUp | null = null;
    try {
      await this.browser.withPage(async (page) => {
        // a share link is opened first; it leads to the post's own page on the same platform
        const target = adapter.shareLink?.(new URL(url)) ? await page.goto(url) : url;
        if (platformOf(target) !== platform) return;
        detail = await adapter.read(page, target, comments, deadline);
        if (detail) await this.images(page, [detail.post], platform, this.cfg.images, deadline, images);
      }, this.pageLimits(deadline, signal));
    } catch (err) {
      if (!(err instanceof Interrupted || err instanceof TimeUp)) throw err;
      cut = err;
    } finally {
      this.spend(platform, deadline.elapsedMs, detail ? 1 : 0);
    }
    const found = detail as Awaited<ReturnType<Adapter['read']>>;
    // after `spend`, so the limits named include this call's time
    if (!found && cut) return t.notRun('social_read', cut instanceof Interrupted ? t.interruptedNothing : t.limitUsed(this.limits()));
    if (!found) return t.notRun('social_read', t.readNone);
    const lines = [
      t.readHead(t.platform[platform], t.duration(deadline.elapsedMs)),
      renderPost(t, 1, found.post, this.opts.timezone, READ_TEXT_MAX),
      ...(found.comments.length ? [[t.comments(found.comments.length), ...found.comments.map((c) => t.comment(oneLine(c.author ?? '?'), oneLine(c.text, COMMENT_TEXT_MAX), c.score))].join('\n')] : []),
      [images.ocrFailure ? t.ocrFailed(images.ocrFailure) : '', t.used(this.limits())].filter(Boolean).join('\n'),
    ];
    return { text: lines.join('\n\n'), blobs: images.blobs };
  }

  private async transcript(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const t = this.t;
    let video = str(args.video).trim();
    const owner = platformOf(video) ?? (bilibiliVideoId(video) ? 'bilibili' : youtubeVideoId(video) ? 'youtube' : null);
    if (owner !== 'youtube' && owner !== 'bilibili') return t.notRun('social_transcript', t.notVideo);
    const picked = this.platformArg('social_transcript', owner);
    if ('refusal' in picked) return picked.refusal;
    const { platform } = picked;
    const left = this.left();
    if (left.ms <= 0) return t.notRun('social_transcript', t.limitUsed(this.limits()));
    const deadline = new Deadline(left.ms, this.now);
    const share = (() => { try { return ADAPTERS[platform].shareLink?.(new URL(video)) ?? false; } catch { return false; } })();
    if (share) {
      // a share link (b23.tv) names no video until it is opened
      try {
        video = await this.browser.withPage((page) => page.goto(video), this.pageLimits(deadline, signal));
      } catch (err) {
        this.spend(platform, deadline.elapsedMs, 0);
        if (!(err instanceof Interrupted || err instanceof TimeUp)) throw err;
        return t.notRun('social_transcript', err instanceof Interrupted ? t.interruptedNothing : t.limitUsed(this.limits()));
      }
    }
    const id = platform === 'bilibili' ? bilibiliVideoId(video) : youtubeVideoId(video);
    if (!id) {
      if (share) this.spend(platform, deadline.elapsedMs, 0);
      return t.notRun('social_transcript', t.notVideo);
    }
    const key = `${platform}:${id}`;
    const counted = this.turn.transcripts.has(key);
    if (!counted && left.posts <= 0) return t.notRun('social_transcript', t.limitUsed(this.limits()));
    const fromSec = Math.max(0, int(args.from_sec) ?? 0);
    let tr = this.transcripts.get(key);
    if (!tr) {
      let got: TranscriptResult | null = null;
      let cut: Interrupted | TimeUp | null = null;
      try {
        got = await this.browser.withPage((page) => ADAPTERS[platform].transcript!(page, video, deadline), this.pageLimits(deadline, signal));
      } catch (err) {
        if (!(err instanceof Interrupted || err instanceof TimeUp)) throw err;
        cut = err;
      } finally {
        this.spend(platform, deadline.elapsedMs, got?.kind === 'ok' && !counted ? 1 : 0, got?.kind === 'ok' && !counted ? 1 : 0);
      }
      // after `spend`, so the limits named include this call's time
      if (cut) return t.notRun('social_transcript', cut instanceof Interrupted ? t.interruptedNothing : t.limitUsed(this.limits()));
      if (got!.kind === 'none') return t.notRun('social_transcript', t.noTranscript(got!.reason, got!.title ?? t.untitled));
      tr = got!.transcript;
      this.transcripts.set(key, tr);
      if (this.transcripts.size > TRANSCRIPT_CACHE) this.transcripts.delete(this.transcripts.keys().next().value!);
    } else {
      if (share) this.spend(platform, deadline.elapsedMs, 0);
      // a transcript an earlier request read counts as one post in this request too
      if (!counted) this.turn.posts++;
    }
    this.turn.transcripts.add(key);
    return `${renderTranscript(t, tr, fromSec, this.cfg.maxTranscriptChars).text}\n\n${t.used(this.limits())}`;
  }

  private async login(args: Record<string, unknown>, fromPanel = false): Promise<string> {
    const t = this.t;
    const platform = PLATFORM_IDS.find((p) => p === args.platform);
    if (!platform) return t.notRun('social_login', t.error(`unknown platform ${String(args.platform)}`));
    const adapter = ADAPTERS[platform];
    await this.browser.openLogin(adapter.loginUrl, () => void this.loginClosed(platform, fromPanel));
    return t.loginOpened(t.platform[platform]);
  }

  /* ---------- comments ---------- */

  /**
   * A comment the bot wrote. With automatic comments on, or as its answer to a reply it was told of
   * while automatic replies are on, it is posted at once unless `holdReason` names a reason to wait;
   * held, failed to post, or neither switch on, it becomes a draft, and the panel is brought up for a
   * draft the person asked for.
   */
  private async comment(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const t = this.t;
    const c = this.cfg.comments;
    const notRun = (why: string) => t.notRun('social_comment', why);
    if (!c.enabled) return notRun(t.commentsOff);
    const url = str(args.url).trim();
    const owner = platformOf(url);
    if (owner !== 'reddit') return notRun(owner ? t.commentRedditOnly : t.notPlatformUrl);
    const picked = this.platformArg('social_comment', owner);
    if ('refusal' in picked) return picked.refusal;
    const target = redditReplyTarget(url);
    if (!target) return notRun(ADAPTERS.reddit.shareLink?.(new URL(url)) ? t.commentShareLink : t.commentNoTarget);
    const text = str(args.text).trim();
    if (!text) return notRun(t.commentEmpty);
    if (text.length > BOT_COMMENT_MAX) return notRun(t.commentTooLong(BOT_COMMENT_MAX));
    if (this.comments.today(this.opts.timezone) >= c.maxPerDay) return notRun(t.commentDayFull(c.maxPerDay));
    const answering = this.answering(target);
    let held: string | null = null;
    if (answering ? c.autoReply : c.auto) {
      held = this.holdReason(text, answering);
      if (!held) {
        try {
          const link = await this.send(target, c.sign ? `${text}\n\n${AUTO_NOTE}` : text, signal);
          this.comments.record({ platform: owner, url, link, text, edited: false, auto: true, ...(answering ? { to: answering.author } : {}) });
          this.awaiting.delete(target);
          return t.commentPostedNow(link);
        } catch (err) {
          // an answer cut off may have reached Reddit
          held = err instanceof Interrupted || err instanceof TimeUp ? t.heldUnsure : t.heldFailed(this.why(err));
        }
      }
    }
    if (this.comments.drafts().length >= DRAFTS_MAX) return notRun(t.commentDraftsFull(DRAFTS_MAX));
    const draft = this.comments.add({ platform: owner, url, target, text });
    // an answer to a reply comes out of a background look, and waits without bringing anything up
    if (!answering) this.opts.showDrafts?.();
    return held ? t.commentHeld(draft.id, held) : t.commentDrafted(draft.id);
  }

  /** The reply `target` answers, while the bot's answer to it is still posted at once. */
  private answering(target: string): { author: string; at: number } | undefined {
    const a = this.awaiting.get(target);
    if (!a || this.now() - a.at <= REPLY_WAIT_MS) return a;
    this.awaiting.delete(target);
    return undefined;
  }

  /** Why an automatic comment waits for the person: a link in it, or its account answered enough today. */
  private holdReason(text: string, answering?: { author: string }): string | null {
    if (hasLink(text)) return this.t.heldLink;
    if (answering && this.comments.answeredToday(answering.author, this.opts.timezone) >= REPLIES_PER_ACCOUNT) return this.t.heldAccount(REPLIES_PER_ACCOUNT);
    return null;
  }

  /** Posts `text` as a reply to `target` with the browser's Reddit login; the comment's link when Reddit names it. */
  private async send(target: string, text: string, signal?: AbortSignal): Promise<string | null> {
    return (await this.browser.withPage((page) => postRedditComment(page, target, text), this.pageLimits(new Deadline(POST_MS, this.now), signal))).link;
  }

  /**
   * Posts draft `id` with the text the person left in it, and tells the bot. A failure is worded for
   * the panel and keeps the draft for another try.
   */
  private async postComment(id: unknown, text: unknown, s: SocialText['comments'], p: SocialText['panel']): Promise<void> {
    const draft = typeof id === 'string' ? this.comments.draft(id) : undefined;
    if (!draft) throw new Error(s.gone);
    if (this.posting.has(draft.id)) throw new Error(s.posting);
    const body = str(text).trim();
    if (!body) throw new Error(s.empty);
    if (body.length > REDDIT_COMMENT_MAX) throw new Error(s.tooLong(REDDIT_COMMENT_MAX));
    if (!this.cfg.platforms[draft.platform]?.enabled) throw new Error(p.platformOff(socialText(this.opts.language?.() ?? 'zh').platforms[draft.platform]));
    if (this.comments.today(this.opts.timezone) + this.posting.size >= this.cfg.comments.maxPerDay) throw new Error(s.dayFull(this.cfg.comments.maxPerDay));
    this.posting.add(draft.id);
    let link: string | null;
    try {
      link = await this.send(draft.target, body);
    } catch (err) {
      if (err instanceof PlatformBlocked) throw new Error(err.kind === 'login' ? s.login : s.blocked(err.detail));
      if (err instanceof CommentRefused) throw new Error(s.refused(err.detail));
      if (err instanceof TimeUp) throw new Error(s.timeUp);
      // the panel words these three itself
      if (err instanceof BrowserMissing || err instanceof BrowserBusy || err instanceof LoginWindowOpen) throw err;
      throw new Error(firstLine(err));
    } finally {
      this.posting.delete(draft.id);
    }
    const edited = body !== draft.text;
    this.comments.record({ platform: draft.platform, url: draft.url, link, text: body, edited, auto: false }, draft.id);
    await this.push(`${SOCIAL_ID}.comment`, this.t.commentPosted(draft.url, link, edited ? oneLine(body, COMMENT_TEXT_MAX) : null), 'flush', 'internal')
      .catch((err: Error) => this.host?.log.warn(`social event not sent: ${err.message}`));
  }

  /** Throws away draft `id` and tells the bot with the next batch. */
  private async discardComment(id: unknown, s: SocialText['comments']): Promise<void> {
    if (typeof id === 'string' && this.posting.has(id)) throw new Error(s.posting);
    const draft = typeof id === 'string' ? this.comments.remove(id) : undefined;
    if (!draft) throw new Error(s.gone);
    await this.push(`${SOCIAL_ID}.comment`, this.t.commentDiscarded(draft.url), 'piggyback', 'internal')
      .catch((err: Error) => this.host?.log.warn(`social event not sent: ${err.message}`));
  }

  /* ---------- automatic replies ---------- */

  private get watchingReplies(): boolean {
    const c = this.cfg.comments;
    return c.enabled && c.autoReply && this.cfg.platforms.reddit?.enabled !== false;
  }

  /** The look at the inbox each `look` makes while automatic replies are on, once every `REPLY_CHECK_MS`. */
  private async lookAtReplies(): Promise<void> {
    if (!this.watchingReplies) {
      this.comments.stopWatching();
      return;
    }
    // a look while the person uses a login window waits for it to close
    if (this.browser.loginOpen || this.now() - this.lastReplyLook < REPLY_CHECK_MS) return;
    await this.checkReplies().catch((err: unknown) => this.host?.log.warn(`social reply check: ${firstLine(err)}`));
  }

  /**
   * Looks at the inbox once. The replies that came since automatic replies were turned on, within
   * `REPLY_MAX_AGE_MS` and from another account, are told to the bot in one event once it is idle;
   * its answer to each is posted at once for `REPLY_WAIT_MS` after.
   */
  private checkReplies(): Promise<void> {
    this.checkingReplies ??= (async () => {
      try {
        this.lastReplyLook = this.now();
        const since = Date.parse(this.comments.watchSince());
        const inbox = await this.browser.withPage((page) => redditInbox(page), this.pageLimits(new Deadline(INBOX_MS, this.now)));
        const me = inbox.me.toLowerCase();
        const fresh = inbox.replies.filter((r) => !this.comments.seen(r.target) && r.createdAtMs >= since && this.now() - r.createdAtMs <= REPLY_MAX_AGE_MS
          && r.author.toLowerCase() !== me && !NO_ANSWER.has(r.author.toLowerCase()));
        this.comments.looked(inbox.replies.map((r) => r.target));
        if (!fresh.length) return;
        for (const r of fresh) this.awaiting.set(r.target, { author: r.author, at: this.now() });
        const t = this.t;
        const text = t.repliesEvent(fresh.map((r) => t.replyLine(`u/${r.author}`, oneLine(r.title), oneLine(r.text, COMMENT_TEXT_MAX), r.url)));
        this.whenIdle(() => this.push(`${SOCIAL_ID}.reply`, text, 'flush'));
      } finally {
        this.checkingReplies = null;
      }
    })();
    return this.checkingReplies;
  }

  /** After a login window closes: whether a login holds, told to the bot (with the next batch when the person opened it). */
  private async loginClosed(platform: PlatformId, fromPanel: boolean): Promise<void> {
    let holds = false;
    try {
      holds = await this.loggedIn(platform);
    } catch (err) {
      this.host?.log.warn(`social login check: ${(err as Error).message}`);
      return;
    }
    this.logins[platform] = holds;
    await this.push(`${SOCIAL_ID}.login`, this.t.loginEvent(this.t.platform[platform], holds), fromPanel ? 'piggyback' : 'flush', 'internal')
      .catch((err: Error) => this.host?.log.warn(`social event not sent: ${err.message}`));
  }

  /** A session cookie first; a platform that sets it for guests too then asks its page. */
  private async loggedIn(platform: PlatformId): Promise<boolean> {
    const adapter = ADAPTERS[platform];
    const { session } = adapter;
    const names = await this.browser.cookieNames(session.domain);
    if (!session.cookies.some((c) => names.includes(c))) return false;
    if (!adapter.loggedIn) return true;
    const deadline = new Deadline(LOGIN_CHECK_MS, this.now);
    try {
      return await this.browser.withPage((page) => adapter.loggedIn!(page), this.pageLimits(deadline));
    } catch (err) {
      // a login or captcha page is no usable login
      if (err instanceof PlatformBlocked) return false;
      throw err;
    }
  }

  /** Checks the login of every platform turned on, in the browser profile. */
  private checkLogins(): Promise<void> {
    this.checkingLogins ??= (async () => {
      try {
        for (const p of PLATFORM_IDS.filter((x) => this.cfg.platforms[x]?.enabled)) {
          try {
            this.logins[p] = await this.loggedIn(p);
          } catch (err) {
            // the profile is busy or missing for every platform alike
            if (err instanceof LoginWindowOpen || err instanceof BrowserMissing) throw err;
            delete this.logins[p];
            this.host?.log.warn(`social login check for ${p}: ${(err as Error).message}`);
          }
        }
      } finally {
        this.checkingLogins = null;
      }
    })();
    return this.checkingLogins;
  }

  private stats(): string {
    const t = this.t;
    const life = this.lifetime.snapshot();
    const read = PLATFORM_IDS.filter((p) => life.platforms[p].ms > 0 || life.platforms[p].posts > 0);
    const lines = read.map((p) => {
      const x = life.platforms[p];
      return t.statsLine(t.platform[p], t.duration(x.ms), x.posts, x.transcripts, x.lastAt ? localStamp(x.lastAt, this.opts.timezone) : undefined);
    });
    const known = PLATFORM_IDS.filter((p) => this.logins[p] !== undefined);
    return [
      t.statsHead(localStamp(life.sinceAt, this.opts.timezone)),
      lines.length ? lines.join('\n') : t.statsNone,
      known.length ? t.statsLogins(known.filter((p) => this.logins[p]).map((p) => t.platform[p]), known.filter((p) => !this.logins[p]).map((p) => t.platform[p])) : '',
      t.statsJobs(this.jobLines()),
    ].filter(Boolean).join('\n');
  }

  private jobLines(): string[] {
    if (!this.cfg.autoscroll.enabled) return [];
    const t = this.t;
    const today = localClock(this.now(), this.opts.timezone).date;
    const last = this.digests.lastRuns();
    return this.jobs().map((j) => t.jobLine(j.at, t.platform[j.platform], t.source(j.source, j.query), j.maxPosts, last[jobKey(j)] === today));
  }

  private jobs(): AutoscrollJob[] {
    return parseJobs(this.cfg.autoscroll.jobs);
  }

  private digest(args: Record<string, unknown>): string {
    const t = this.t;
    const id = str(args.id).trim();
    if (!id) {
      const list = this.digests.list();
      if (!list.length) return t.notRun('social_digest', t.digestNone);
      return t.digestList(list.map((d) => t.digestListLine(d.id, `${t.platform[d.job.platform]}, ${t.source(d.job.source, d.job.query)}`, d.posts, d.error)));
    }
    const d = this.digests.get(id);
    if (!d) return t.notRun('social_digest', t.digestMissing);
    const offset = Math.max(0, int(args.offset) ?? 0);
    if (offset >= d.posts.length && d.posts.length) return t.notRun('social_digest', t.digestPastEnd(d.posts.length));
    const page = renderPage(t, d.posts, offset, DIGEST_PAGE_CHARS, this.opts.timezone, DIGEST_TEXT_MAX);
    const what = `${t.platform[d.job.platform]}, ${t.source(d.job.source, d.job.query)}`;
    return [
      t.digestHead(what, localStamp(d.startedAt, this.opts.timezone), d.posts.length, Math.min(offset + 1, d.posts.length), page.next),
      page.text || t.nothing,
      page.next < d.posts.length ? t.digestNext(page.next) : '',
    ].filter(Boolean).join('\n\n');
  }

  /* ---------- daily autoscroll ---------- */

  /** Starts the jobs that are due, one after another, and looks at the inbox while automatic replies are on. */
  private async look(): Promise<void> {
    void this.lookAtReplies();
    // a job due while the person uses a login window runs once it is closed
    if (this.running || !this.cfg.autoscroll.enabled || this.browser.loginOpen) return;
    const due = dueJobs(this.jobs().filter((j) => this.cfg.platforms[j.platform]?.enabled), this.digests.lastRuns(), this.now(), this.opts.timezone);
    for (const job of due) {
      if (!this.host) return;
      await this.runJob(job);
    }
  }

  /** Runs `job` now: reads its posts, keeps them as a digest, and tells the bot once it is idle. */
  private async runJob(job: AutoscrollJob): Promise<void> {
    const t = this.t;
    const date = localClock(this.now(), this.opts.timezone).date;
    const before = this.digests.lastRuns()[jobKey(job)];
    try {
      // marked before it runs, so a run that crashes the World is not repeated all day
      this.digests.markRun(job, date);
    } catch (err) {
      // unmarked, the job would start again every SCHEDULE_MS
      this.host?.log.warn(`social job not started, its run date was not saved: ${(err as Error).message}`);
      return;
    }
    this.running = jobKey(job);
    const adapter = ADAPTERS[job.platform];
    const collector = new Collector(job.platform, job.maxPosts, job.images, new Deadline(this.cfg.autoscroll.maxMinutes * 60_000, this.now));
    const what = `${t.platform[job.platform]}, ${t.source(job.source, job.query)}`;
    const d: Digest = { id: digestId(date, job), job, startedAt: new Date(this.now()).toISOString(), ms: 0, posts: [], skipped: collector.skipped, stopped: 'end' };
    let r: Omit<Gathered, 'blobs'> = { stopped: 'end', ocrFailure: null, cut: null };
    try {
      r = await this.gather(adapter, { source: job.source, query: job.query }, collector, job.images);
      d.stopped = r.stopped;
    } catch (err) {
      d.error = this.why(err);
    } finally {
      d.ms = collector.deadline.elapsedMs;
      d.posts = collector.posts;
      this.lifetime.add(job.platform, d.ms, { posts: collector.posts.length });
      this.running = null;
    }
    if (this.stopping) {
      // cut off by the World stopping: the job runs again when next due
      try { this.digests.markRun(job, before); } catch { /* it ran today */ }
      return;
    }
    try {
      this.digests.save(d);
    } catch (err) {
      // the bot is still told; social_digest cannot read the posts back
      this.host?.log.warn(`social digest not saved: ${(err as Error).message}`);
    }
    const text = d.error && !d.posts.length
      ? t.digestFailed(what, d.error)
      : t.digestEvent(what, t.posts(d.posts.length, VIDEO_PLATFORMS.has(job.platform)), t.duration(d.ms), this.summary(collector, r, false).join(' ') + ' ', d.id);
    this.whenIdle(() => this.push(`${SOCIAL_ID}.digest`, text, 'flush'));
  }

  /* ---------- prompt ---------- */

  envPromptVars(): Record<string, string> {
    const t = this.t;
    return {
      'social.platforms': t.envPlatforms(PLATFORM_IDS.filter((p) => this.cfg.platforms[p]?.enabled).map((p) => t.platform[p])),
      'social.maxPosts': String(this.cfg.maxPosts),
      'social.maxSec': String(this.cfg.maxSec),
      'social.images': t.envImages[this.cfg.images],
      'social.autoscroll': t.envAutoscroll(this.jobLines()),
      'social.comments': t.envComments(this.cfg.comments),
    };
  }

  private envPromptFile(): string {
    const file = ENV_PROMPT_FILES[this.language];
    return existsSync(file) ? file : ENV_PROMPT_FILES.zh;
  }

  /* ---------- WebUI ---------- */

  private panelState(): SocialPanelState {
    const c = this.cfg;
    return {
      config: {
        maxPosts: c.maxPosts, maxSec: c.maxSec, images: c.images, maxTranscriptChars: c.maxTranscriptChars, showBrowser: c.showBrowser, browserFile: c.browserFile,
        platforms: Object.fromEntries(PLATFORM_IDS.map((p) => [p, c.platforms[p]?.enabled !== false])) as Record<PlatformId, boolean>,
        autoscroll: { enabled: c.autoscroll.enabled, maxMinutes: c.autoscroll.maxMinutes },
        comments: { enabled: c.comments.enabled, maxPerDay: c.comments.maxPerDay, auto: c.comments.auto, autoReply: c.comments.autoReply, sign: c.comments.sign },
      },
      jobs: this.jobs(),
      browser: findBrowser(c.browserFile),
      logins: { ...this.logins },
      checkingLogins: this.checkingLogins !== null,
      lifetime: this.lifetime.snapshot(),
      digests: this.digests.list(10),
      running: this.running,
      comments: {
        drafts: this.comments.drafts(), posted: this.comments.posted(POSTED_SHOWN), today: this.comments.today(this.opts.timezone), posting: [...this.posting],
        checkedAt: this.comments.checkedAt,
      },
      caps: {
        maxPosts: MAX_POSTS_CAP, maxSec: MAX_SEC_CAP, jobPosts: JOB_POSTS_CAP, jobs: MAX_JOBS, commentsPerDay: COMMENTS_PER_DAY_CAP,
        replyCheckMin: REPLY_CHECK_MS / 60_000, repliesPerAccount: REPLIES_PER_ACCOUNT,
      },
    };
  }

  /** A panel call, its refusals and the browser's failures worded in the panel's `language`. */
  private async invoke(panel: string, method: string, args: unknown[], language: Language): Promise<unknown> {
    if (panel !== 'social') throw new Error(`unknown panel ${panel}`);
    const s = socialText(language).panel;
    try {
      return await this.panelCall(method, args, s, socialText(language).comments);
    } catch (err) {
      if (err instanceof BrowserMissing) throw new Error(err.configured ? s.browserFileMissing : s.browserMissing);
      if (err instanceof BrowserBusy) throw new Error(s.busy);
      if (err instanceof LoginWindowOpen) throw new Error(s.loginOpen);
      throw err;
    }
  }

  private async panelCall(method: string, args: unknown[], s: SocialText['panel'], c: SocialText['comments']): Promise<unknown> {
    switch (method) {
      case 'state':
        return this.panelState();
      case 'checkLogins':
        await this.checkLogins();
        return this.panelState();
      case 'login':
        await this.login({ platform: args[0] }, true);
        return this.panelState();
      case 'setJobs':
        // /api/config writes no list: the person's job list in one write
        this.opts.persist({ autoscroll: { jobs: parseJobs(args[0]) } });
        return this.panelState();
      case 'runNow': {
        const job = this.jobs().find((j) => jobKey(j) === args[0]);
        if (!job) throw new Error(s.noSuchJob);
        if (!this.cfg.platforms[job.platform]?.enabled) throw new Error(s.platformOff(socialText(this.opts.language?.() ?? 'zh').platforms[job.platform]));
        if (this.running) throw new Error(s.jobRunning);
        if (this.browser.loginOpen) throw new Error(s.loginOpen);
        if (!this.host) throw new Error(s.notRunning);
        void this.runJob(job);
        return this.panelState();
      }
      case 'resetLifetime':
        this.lifetime.reset();
        return this.panelState();
      case 'commentPost':
        await this.postComment(args[0], args[1], c, s);
        return this.panelState();
      case 'commentDiscard':
        await this.discardComment(args[0], c);
        return this.panelState();
      case 'checkReplies':
        if (!this.watchingReplies) throw new Error(c.notWatching);
        try {
          await this.checkReplies();
        } catch (err) {
          if (err instanceof PlatformBlocked && err.kind === 'login') throw new Error(c.login);
          // the panel words these three itself
          if (err instanceof BrowserMissing || err instanceof BrowserBusy || err instanceof LoginWindowOpen) throw err;
          throw new Error(c.checkFailed(firstLine(err)));
        }
        return this.panelState();
      default:
        throw new Error(`unknown method ${method}`);
    }
  }

  private storage(language: Language): StoragePart[] {
    const s = socialText(language).console.storage;
    const size = (dir: string): string => {
      if (!existsSync(dir)) return '0 MB';
      let bytes = 0;
      const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else bytes += statSync(p).size; } };
      try { walk(dir); } catch { /* files change while the browser runs */ }
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    };
    return [
      { key: `${SOCIAL_ID}-browser`, label: s.profile.label, kind: 'disk', location: this.profileDir, danger: true, note: s.profile.note, stat: () => size(this.profileDir),
        clear: async () => { await this.browser.close(); rmSync(this.profileDir, { recursive: true, force: true }); this.logins = {}; return s.cleared; } },
      { key: `${SOCIAL_ID}-ocr`, label: s.ocr.label, kind: 'disk', location: this.opts.ocrDir, note: s.ocr.note, stat: () => size(this.opts.ocrDir),
        clear: async () => { await this.ocr.release(); this.ocr.clear(); return s.cleared; } },
      { key: `${SOCIAL_ID}-digests`, label: s.digests.label, kind: 'disk', location: join(this.opts.dataDir, `${SOCIAL_ID}-digests`), stat: () => String(this.digests.ids().length),
        clear: () => { this.digests.clear(); return s.cleared; } },
    ];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const c = socialText(language).console;
    const browser = findBrowser(this.cfg.browserFile);
    return {
      label: c.label,
      lamps: [{ label: c.browser, state: browser ? (this.running ? 'loading' : 'online') : 'offline', hint: browser ?? c.browserMissing }],
      panels: [{ id: 'social', ...c.panel, getMethods: ['state'] }],
      invoke: (panel, method, args) => this.invoke(panel, method, args, language),
      config: [socialConfigGroup(language)],
      storage: this.storage(language),
      promptDocs: [{
        key: `worlds.${SOCIAL_ID}.envPrompt`,
        ...c.envPrompt,
        path: this.envPromptFile(),
        role: 'envPrompt',
        vars: ['social.platforms', 'social.maxPosts', 'social.maxSec', 'social.images', 'social.autoscroll', 'social.comments']
          .map((name) => ({ name, description: c.vars[name] ?? name, ...(name === 'social.autoscroll' ? { multiline: true } : {}) })),
      }],
    };
  }
}

