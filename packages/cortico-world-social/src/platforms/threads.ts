/**
 * Threads from its pages: the home feed, search, a profile, and a post with its replies. A reply is
 * typed into the dialog the post's reply button opens; a post into the dialog Threads' share intent
 * opens with the text in it (`compose`). Threads names its buttons only in words, so they are looked
 * for in the languages its interface shows.
 */
import type { PageSession } from '../browser.ts';
import { PlatformBlocked, domToPost, scrollCollect } from '../collect.ts';
import { DOM_READ_DEFAULTS, readThreadsPosts } from './dom.ts';
import { accountName, hostIs, type Adapter, type NewPost } from './adapter.ts';
import { compose, labelled } from './compose.ts';

const ORIGIN = 'https://www.threads.com';
const READY = 'div[data-pressable-container="true"]';

async function open(page: PageSession, url: string): Promise<void> {
  const at = await page.goto(url);
  if (new URL(at).pathname.startsWith('/login')) throw new PlatformBlocked('threads', 'login');
}

/** The longest post or reply Threads takes. */
export const THREADS_TEXT_MAX = 500;
/** The send button's word, and the reply button's label, in the languages Threads may show. */
const POST_WORDS = ['Post', '发布', '發佈', '發布', '投稿', '게시', 'Publier', 'Posten', 'Veröffentlichen', 'Publicar', 'Pubblica', 'Опубликовать'];
const REPLY_WORDS = ['Reply', '回复', '回覆', '返信', '답글', 'Répondre', 'Antworten', 'Responder', 'Rispondi', 'Ответить'];
const DIALOG_BOX = 'div[role="dialog"] div[contenteditable="true"]';
const SEND = labelled('div[role="dialog"]', 'div[role="button"]', POST_WORDS);
/** Threads sends a post from its own pages; the request is the one that carries the text. */
const SENDS = /^https:\/\/www\.threads\.(com|net)\//;

/** What a reply on a Threads link answers: the post's page. */
export function threadsReplyTarget(url: URL): string | null {
  if (!hostIs(url, 'threads.com', 'threads.net')) return null;
  const path = /^\/@[\w.]+\/post\/[\w-]+/.exec(url.pathname)?.[0];
  return path ? `${ORIGIN}${path}` : null;
}

/** Replies `text` to the post at `target`, in the dialog its reply button opens. */
export async function postThreadsReply(page: PageSession, target: string, text: string): Promise<{ link: string | null }> {
  await open(page, target);
  await compose(page, 'threads', { open: [REPLY_WORDS.map((w) => `svg[aria-label="${w}"]`).join(', ')], box: DIALOG_BOX, send: SEND, request: SENDS }, text);
  return { link: null };
}

/** Posts `post.text` from the dialog Threads' share intent opens with it. */
export async function postThreads(page: PageSession, post: NewPost): Promise<{ link: string | null }> {
  await open(page, `${ORIGIN}/intent/post?text=${encodeURIComponent(post.text)}`);
  await compose(page, 'threads', { box: DIALOG_BOX, send: SEND, request: SENDS, filled: true }, post.text);
  return { link: null };
}

export const THREADS: Adapter = {
  id: 'threads',
  loginUrl: `${ORIGIN}/login`,
  session: { domain: '.threads.com', cookies: ['sessionid'] },
  sources: ['feed', 'search', 'account'],

  async list(page, req, collector) {
    const url = req.source === 'feed' ? `${ORIGIN}/`
      : req.source === 'search' ? `${ORIGIN}/search?q=${encodeURIComponent(req.query.trim())}&serp_type=default${req.sort === 'recent' || req.sort === 'latest' ? '&filter=recent' : ''}`
      : `${ORIGIN}/@${encodeURIComponent(accountName(req.query))}`;
    await open(page, url);
    await scrollCollect(page, collector, { reader: readThreadsPosts, ready: READY });
  },

  owns: (url) => hostIs(url, 'threads.com', 'threads.net'),

  write: {
    replyTarget: threadsReplyTarget,
    comment: postThreadsReply,
    commentMax: THREADS_TEXT_MAX,
    posts: { needs: [], max: THREADS_TEXT_MAX, publish: postThreads },
  },

  async read(page, url, maxComments) {
    await open(page, `${ORIGIN}${new URL(url).pathname}`);
    await page.waitFor(READY, 10_000);
    const [first, ...rest] = await page.run(readThreadsPosts, DOM_READ_DEFAULTS);
    if (!first) return null;
    return {
      post: domToPost('threads', first, 'adapter'),
      comments: rest.slice(0, maxComments).map((r) => ({ author: r.author || undefined, text: r.text })),
    };
  },
};
