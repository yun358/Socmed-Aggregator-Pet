/** Tool declarations; `SocialWorld.tools()` binds the handlers. Descriptions are English whatever the model-text language. */
import type { ToolDef } from 'cortico/core/types.ts';
import { DRAFTS_MAX, type WriteKind } from './comments.ts';
import { SOURCE_KINDS } from './config.ts';
import { MODEL_TEXT } from './model-text.ts';
import { POST_PLATFORMS, limitOf } from './platforms/index.ts';
import { PLATFORM_IDS, type PlatformId } from './posts.ts';
import { REDDIT_TITLE_MAX } from './platforms/reddit.ts';

export const COMMENTS_MAX = 30;
export const COMMENTS_DEFAULT = 10;

/** "Reddit 9961, X 241, …": the longest `kind` the bot may write on each of `platforms`. */
const limits = (platforms: readonly PlatformId[], kind: WriteKind) => platforms.map((p) => `${MODEL_TEXT.en.platform[p]} ${limitOf(p, kind, true)}`).join(', ');
const COUNTING = 'X counts a link as 23 characters and a CJK character as 2.';

export const SOCIAL_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'social_browse',
    tags: ['read'],
    description: "List posts from a social media platform, read in your own browser: its feed, a search, an account's posts, or a community. On YouTube and Bilibili the items are videos (title, channel, length, views); elsewhere video posts are left out. On news (Google News) the items are headlines with their publisher, and on web they are search results (title, snippet, site); open any of them with social_read. Counts against the request's limits and stops when they are reached. The receipt gives each post's text, what its images say, and its link, then what was left out and how much of the limits is used.",
    parameters: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: [...PLATFORM_IDS] },
        source: { type: 'string', enum: [...SOURCE_KINDS], description: "feed: the platform's own feed or recommendations (personal when logged in). search: posts matching query. account: posts of the account in query (handle, name, id or profile link). community: the subreddit or Facebook group in query; on Substack, a category (such as Technology), read as the publications on its leaderboard with the most liked of their recent posts. On news: feed is the top stories of the person's edition, community a topic (world, nation, business, technology, entertainment, sports, science or health; any other is searched), search finds articles. On web, only search, with query written as keywords rather than a question (heat pump running cost, not how much does a heat pump cost to run): Bing, or DuckDuckGo and Google when one is blocked." },
        query: { type: 'string', description: 'Search terms, account, community or Google News topic; leave out for feed. Reddit search accepts subreddit:name to stay in one subreddit; Instagram search takes #tag for a hashtag; a Rednote account is its profile link; a Substack account is a publication (its name, name.substack.com or its address), a person (@handle) for their Notes and posts, or me for the person\'s own.' },
        sort: { type: 'string', description: 'Optional order. Reddit listings: hot, new, top, rising; Reddit search: relevance, top, new, comments. X search: top or latest. YouTube and Bilibili search: relevance, date or views. Threads search: top or recent. A Substack publication: new or top (most liked); a Substack person or me: notes or posts for only those; a Substack category: rising or paid (bestsellers).' },
        period: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year', 'all'], description: 'For Reddit top: the period ranked. For YouTube search: only videos uploaded within the last day, week, month or year. For a news search: only articles from the last hour, day, week, month or year.' },
        max_posts: { type: 'integer', minimum: 1, description: 'How many to return; by default all the request has left.' },
      },
      required: ['platform', 'source'],
    },
  },
  {
    name: 'social_read',
    tags: ['read'],
    description: 'Open one post, article or any web page by its link and read all of it: the full text, its first 4 images (as the image setting says), and on Reddit, X, Threads, Bilibili and Substack its top comments. A page of no platform here, and the article a Google News link leads to, are read as web pages, without images: an article gives its title, site, author, time and text; a page that is no article, such as a news site\'s front page, gives its headlines with their links. Counts as one post against the request\'s limits.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The link of the post or page, as a receipt gave it or the person named it.' },
        comments: { type: 'integer', minimum: 0, maximum: COMMENTS_MAX, description: `Top comments to include; default ${COMMENTS_DEFAULT}.` },
      },
      required: ['url'],
    },
  },
  {
    name: 'social_transcript',
    tags: ['read'],
    description: "Read what is said in a YouTube or Bilibili video, from its captions or subtitles, with time stamps. A long transcript comes in parts: the receipt says where to continue with from_sec. The first part of a video counts as one post against the request's limits; later parts of the same video in the same request do not.",
    parameters: {
      type: 'object',
      properties: {
        video: { type: 'string', description: 'The video link, or its id (YouTube: 11 characters; Bilibili: BV…).' },
        from_sec: { type: 'integer', minimum: 0, description: 'Start here, in seconds from the beginning; default 0.' },
      },
      required: ['video'],
    },
  },
  {
    name: 'social_login',
    tags: ['act'],
    description: "Open a visible window of your browser at a platform's login page, so the person can log in there, or pass a check the platform showed. On web, open a page of the person's choice instead, such as a news site's login page or a page that showed a check. Returns at once; when the person closes the window, an event says whether a login holds. Logins are kept in your browser's own profile, apart from the person's everyday browser.",
    parameters: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: [...PLATFORM_IDS] },
        url: { type: 'string', description: 'With platform web: the page to open (http or https).' },
      },
      required: ['platform'],
    },
  },
  {
    name: 'social_comment',
    tags: ['act'],
    description: `Write a comment in the person's name on a post or video of any social platform here (not Google News or other web pages), or, on Reddit, X, Threads and Bilibili, a reply to a comment by the comment's link. Usually it becomes a draft that waits on the Social media page of the settings window, where the person edits it, posts it or discards it, and an event says which. When the person has turned on automatic comments, or automatic replies and this answers a reply an event told you of, it is queued instead: it goes out on its own a minute or more later, spaced from their other comments, and an event gives its link. One with a link, or past a limit, still waits as a draft. Comment only when the person asks you to, or to answer such a reply. At most ${DRAFTS_MAX} drafts wait at a time.`,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The link of the post, video or comment to reply to, as a receipt gave it.' },
        text: { type: 'string', description: `The comment: Markdown on Reddit, plain text elsewhere. At most: ${limits(PLATFORM_IDS, 'comment')}. ${COUNTING}` },
      },
      required: ['url', 'text'],
    },
  },
  {
    name: 'social_post',
    tags: ['act'],
    description: "Write a new post in the person's name: on X, Threads, Reddit (a text post in a subreddit) or Bilibili (a dynamic). Like social_comment, it becomes a draft for the person, unless they turned on automatic posts; then it is queued, goes out on its own spaced from their other posts, and an event gives its link. One with a link still waits as a draft. Post only when the person asks you to. On Substack, new posts are Notes: use social_note.",
    parameters: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: [...POST_PLATFORMS] },
        text: { type: 'string', description: `The post: Markdown on Reddit, plain text elsewhere. At most: ${limits(POST_PLATFORMS, 'post')}. ${COUNTING}` },
        title: { type: 'string', description: `Reddit only, and needed there: the title, at most ${REDDIT_TITLE_MAX} characters.` },
        community: { type: 'string', description: 'Reddit only, and needed there: the subreddit, as r/name or its link.' },
      },
      required: ['platform', 'text'],
    },
  },
  {
    name: 'social_note',
    tags: ['act'],
    description: "Write a Substack Note in the person's name, or a reply to a Note. Like social_comment, it becomes a draft for the person, unless they turned on automatic Notes; then it is queued, goes out on its own spaced from their other Notes, and an event gives its link. One with a link still waits as a draft. Write one when the person asks, or when an event asks for one of their daily Notes.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: `The Note, plain text; each line is a paragraph. At most ${limitOf('substack', 'note', true)} characters.` },
        reply_to: { type: 'string', description: 'The link of the Note to reply to (…/note/c-…), as a receipt gave it; leave out for a new Note.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'social_draft',
    tags: ['act'],
    description: "Create a post draft in the person's Substack publication, the one set on the Social media page. Nothing publishes it: the person edits and publishes it in Substack's editor, at the link the receipt gives. Draft one only when the person asks.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        subtitle: { type: 'string', description: 'Optional.' },
        body: { type: 'string', description: 'The post in Markdown: paragraphs, # to ### headings, - and 1. lists, > quotes, **bold**, *italics* and [links](https://…).' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'social_stats',
    tags: ['read'],
    description: 'The lifetime counter: time spent reading each platform since the counter started, with posts and transcripts read; which platforms are logged in, as last checked; and the daily autoscroll jobs.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'social_digest',
    tags: ['read'],
    description: 'Read the posts a daily autoscroll run collected, a page at a time, or list the saved runs (the last 14 days). Does not count against the request\'s limits.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The run, as the event or the list names it; leave out to list the saved runs.' },
        offset: { type: 'integer', minimum: 0, description: 'Start at this post (from 0); default 0.' },
      },
    },
  },
];
