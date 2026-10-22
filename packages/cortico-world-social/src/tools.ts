/** Tool declarations; `SocialWorld.tools()` binds the handlers. Descriptions are English whatever the model-text language. */
import type { ToolDef } from 'cortico/core/types.ts';
import { SOURCE_KINDS } from './config.ts';
import { PLATFORM_IDS } from './posts.ts';

export const COMMENTS_MAX = 30;
export const COMMENTS_DEFAULT = 10;

export const SOCIAL_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'social_browse',
    tags: ['read'],
    description: "List posts from a social media platform, read in your own browser: its feed, a search, an account's posts, or a community. On YouTube and Bilibili the items are videos (title, channel, length, views); elsewhere video posts are left out. Counts against the request's limits and stops when they are reached. The receipt gives each post's text, what its images say, and its link, then what was left out and how much of the limits is used.",
    parameters: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: [...PLATFORM_IDS] },
        source: { type: 'string', enum: [...SOURCE_KINDS], description: "feed: the platform's own feed or recommendations (personal when logged in). search: posts matching query. account: posts of the account in query (handle, name, id or profile link). community: the subreddit or Facebook group in query." },
        query: { type: 'string', description: 'Search terms, account or community; leave out for feed. Reddit search accepts subreddit:name to stay in one subreddit; Instagram search takes #tag for a hashtag; a Rednote account is its profile link.' },
        sort: { type: 'string', description: 'Optional order. Reddit listings: hot, new, top, rising; Reddit search: relevance, top, new, comments. X search: top or latest. YouTube and Bilibili search: relevance, date or views. Threads search: top or recent.' },
        period: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year', 'all'], description: 'For Reddit top: the period ranked.' },
        max_posts: { type: 'integer', minimum: 1, description: 'How many to return; by default all the request has left.' },
      },
      required: ['platform', 'source'],
    },
  },
  {
    name: 'social_read',
    tags: ['read'],
    description: 'Open one post by its link and read all of it: the full text, its first 4 images (as the image setting says), and on Reddit, X, Threads and Bilibili its top comments. Counts as one post against the request\'s limits.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The post link, as a receipt gave it.' },
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
    description: "Open a visible window of your browser at a platform's login page, so the person can log in there, or pass a check the platform showed. Returns at once; when the person closes the window, an event says whether a login holds. Logins are kept in your browser's own profile, apart from the person's everyday browser.",
    parameters: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: [...PLATFORM_IDS] },
      },
      required: ['platform'],
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
