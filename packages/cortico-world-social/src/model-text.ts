/**
 * What the bot reads from this World (receipts, events, environment prompt values), in Chinese and in
 * English; `en: typeof zh` keeps the two tables' keys and signatures the same. Tool names and
 * `[social]` in brackets are the same in both. Post text, titles and OCR output go into these lines as the platform or OCR
 * gave them.
 */
import type { NoTranscript } from './platforms/adapter.ts';
import type { ImageMode } from './config.ts';
import type { StopReason } from './collect.ts';
import { ATTACHED_MAX, IMAGES_PER_POST, type PlatformId, type SourceKind } from './posts.ts';

export type ModelLanguage = 'zh' | 'en';

export interface Limits {
  posts: number;
  maxPosts: number;
  sec: number;
  maxSec: number;
}

type Unread = 'time' | 'cap' | 'download' | 'decode' | 'ocr';
type Block = 'login' | 'captcha' | 'consent' | 'blocked';

const zh = {
  platform: { reddit: 'Reddit', x: 'X', facebook: 'Facebook', threads: 'Threads', instagram: 'Instagram', youtube: 'YouTube', bilibili: '哔哩哔哩', rednote: '小红书' } as Record<PlatformId, string>,
  /** What a listing reads: the feed, a search, an account or a community. */
  source: (kind: SourceKind, query: string, sort?: string, period?: string): string => {
    const order = [sort, period].filter(Boolean).join(',');
    const base = kind === 'feed' ? '首页推荐' : kind === 'search' ? `搜索「${query}」` : kind === 'account' ? `账号 ${query}` : `社区 ${query}`;
    return order ? `${base}(${order})` : base;
  },
  duration: (ms: number): string => {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分 ${s % 60} 秒`;
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  },
  posts: (n: number, video: boolean) => `${n} ${video ? '个视频' : '条帖子'}`,

  browseHead: (platform: string, what: string, posts: string, took: string) => `[social_browse] ${platform},${what}:${took}内读到 ${posts}。`,
  leftOut: (parts: string[]) => `略过了:${parts.join(',')}。`,
  leftVideo: (n: number) => `${n} 条视频帖子(这个平台的视频不读)`,
  leftImage: (n: number) => `${n} 条带图片的帖子(只读文字)`,
  leftAd: (n: number) => `${n} 条广告`,
  stopped: {
    count: '读到要的数量就停了。',
    time: '到了时间上限就停了,后面可能还有。',
    end: '页面上没有更多了。',
    interrupted: '被打断了,这是打断前读到的。',
  } as Record<StopReason, string>,
  generic: '有些帖子是通用读取器读的(没认出页面的版式):作者、时间与数字可能缺失或混在正文里。',
  used: (l: Limits) => `这次请求已用 ${l.posts}/${l.maxPosts} 条、${l.sec}/${l.maxSec} 秒(上限由对方在「社交媒体」页设置)。`,
  ocrFailed: (why: string) => `OCR 没能运行(${why}),图片没有读。`,
  nothing: '什么也没找到。',

  postHead: (i: number, parts: string[]) => `[${i}] ${parts.join(' · ')}`,
  title: (t: string) => `标题:${t}`,
  cut: (total: number) => `……(全文 ${total} 字,social_read 可读全文)`,
  imageOcr: (n: number, text: string) => `图 ${n},OCR 识别的文字(可能有错):${text}`,
  imageOcrNone: (n: number) => `图 ${n}:OCR 没有识别出文字。`,
  imageAlt: (n: number, alt: string) => `图 ${n},平台的图片描述:${alt}`,
  imageAttached: (n: number, k: number) => `图 ${n}:作为下方第 ${k} 张图片附上。`,
  imageUnread: (n: number, why: Unread) => `图 ${n}:没有读(${{ time: '到了时间上限', cap: `一条帖子只读前 ${IMAGES_PER_POST} 张`, download: '下载失败', decode: 'OCR 读不了这个图片文件', ocr: 'OCR 无法运行' }[why]})。`,
  attachedCaption: (k: number, post: number, image: number) => `第 ${k} 张:帖子 ${post} 的图 ${image}`,

  notRun: (tool: string, why: string) => `[${tool} 没执行] ${why}`,
  failed: (tool: string, why: string) => `[${tool} 失败] ${why}`,
  platformOff: (platform: string) => `${platform}在「社交媒体」页被关掉了。`,
  noSource: (platform: string, kind: SourceKind, has: SourceKind[]) => `${platform}没有「${{ feed: '首页推荐', search: '搜索', account: '账号', community: '社区' }[kind]}」这一种;它有:${has.map((k) => ({ feed: 'feed', search: 'search', account: 'account', community: 'community' }[k])).join('、')}。`,
  needQuery: 'search、account 与 community 都要给 query。',
  limitUsed: (l: Limits) => `这次请求的上限已用完(${l.posts}/${l.maxPosts} 条,${l.sec}/${l.maxSec} 秒)。用已读到的回答;对方可以在「社交媒体」页调高上限。`,
  noBrowser: '这台电脑上没找到基于 Chromium 的浏览器(Chrome、Edge、Brave 或 Chromium)。对方可以装一个,或在「社交媒体」页填写浏览器的路径。',
  noBrowserAt: (path: string) => `「社交媒体」页填写的浏览器路径不存在:${path}。对方可以改正它,或清空它让应用自己查找。`,
  loginWindowOpen: '浏览器的登录窗口还开着,对方关掉它之后才能继续读取(Mac 上要用 Cmd+Q 退出那个浏览器)。',
  blocked: (platform: string, id: PlatformId, kind: Block, detail: string): string => ({
    login: `${platform}要求登录。调用 social_login(${id})打开一个窗口,让对方在里面登录。`,
    captcha: `${platform}弹出了人机验证。调用 social_login(${id}),让对方在窗口里完成验证。`,
    consent: `${platform}先要选择是否接受 Cookie。调用 social_login(${id}),让对方在窗口里选择。`,
    blocked: `${platform}拒绝了请求${detail ? `(${detail})` : ''},过一会儿再试可能可以。`,
  })[kind],
  busy: (pages: number) => `浏览器正在后台读取(${pages} 个页面,每日自动浏览),读完后才能打开窗口。`,
  error: (message: string) => `出错:${message}`,

  readHead: (platform: string, took: string) => `[social_read] ${platform},用时 ${took}:`,
  readNone: '页面上没有找到帖子。',
  notPlatformUrl: '这不是这几个平台的链接:Reddit、X、Facebook、Threads、Instagram、YouTube、哔哩哔哩、小红书。',
  comments: (n: number) => `热门评论(${n} 条):`,
  comment: (author: string, text: string, score?: string) => `- ${author}${score ? `(${score})` : ''}:${text}`,

  transcriptHead: (title: string, author: string, duration: string, language: string, generated: boolean) =>
    `[social_transcript] 「${title}」 — ${author} · ${duration} · 字幕:${language}${generated ? '(平台语音识别生成)' : ''}`,
  transcriptSpan: (from: string, to: string, total: string, toEnd: boolean) => (toEnd ? `${from}–${to}(到结尾):` : `${from}–${to},全长 ${total}:`),
  transcriptMore: (sec: number, max: number) => `到了每次 ${max} 字的上限。余下的部分:再调用 social_transcript,from_sec 给 ${sec}。`,
  noTranscript: (reason: NoTranscript, title: string) => ({
    'no-captions': `「${title}」没有字幕,读不到文字稿。`,
    login: `哔哩哔哩只给登录的观众看「${title}」的字幕。调用 social_login(bilibili)让对方登录。`,
    unavailable: `「${title}」的文字稿没能读到(视频或字幕没有加载出来)。`,
  })[reason],
  notVideo: '文字稿只有 YouTube 与哔哩哔哩的视频有;请给视频链接或视频 id。',
  untitled: '这个视频',
  interruptedNothing: '被打断了,还什么都没读到。',

  loginOpened: (platform: string) => `[social_login] 已在${platform}的登录页打开浏览器窗口。告诉对方在里面登录,登录完关掉窗口;之后会有事件说明登录是否生效。`,
  loginEvent: (platform: string, holds: boolean) => `[social] ${platform}的登录窗口关掉了。${holds ? '登录已生效。' : '没有发现登录。'}`,

  statsHead: (since: string) => `[social_stats] 自 ${since} 起在各平台读取的用时:`,
  statsLine: (platform: string, took: string, posts: number, transcripts: number, last?: string) =>
    `- ${platform}:${took},${posts} 条帖子或视频,${transcripts} 份文字稿${last ? `,上次 ${last}` : ''}`,
  statsNone: '还没有读过任何平台。',
  statsLogins: (yes: string[], no: string[]) => `登录:${yes.length ? `已登录 ${yes.join('、')}` : '都没有登录'}${no.length && yes.length ? `;未登录 ${no.join('、')}` : ''}。`,
  statsJobs: (lines: string[]) => (lines.length ? `每日自动浏览:\n${lines.join('\n')}` : '每日自动浏览:关闭。'),
  jobLine: (at: string, platform: string, what: string, posts: number, ranToday: boolean) => `- 每天 ${at}:${platform},${what},${posts} 条${ranToday ? '(今天已读)' : ''}`,

  digestEvent: (what: string, posts: string, took: string, leftOut: string, id: string) =>
    `[social] 每日自动浏览「${what}」读完了:${took}内读到 ${posts}。${leftOut}对方设置它是为了看摘要:用 social_digest(id「${id}」)读这些帖子,用你自己的话告诉对方要紧的内容。`,
  digestFailed: (what: string, why: string) => `[social] 每日自动浏览「${what}」没能运行:${why}`,
  digestHead: (what: string, startedAt: string, total: number, from: number, to: number) => `[social_digest] ${what},${startedAt} 读取,第 ${from}–${to} 条,共 ${total} 条。`,
  digestNext: (offset: number) => `余下的:再调用 social_digest,offset 给 ${offset}。`,
  digestMissing: '没有这个 id 的摘要。',
  digestPastEnd: (total: number) => `这份摘要只有 ${total} 条,offset 超出了范围。`,
  digestNone: '还没有每日自动浏览的记录。',
  digestList: (lines: string[]) => `[social_digest] 保存的每日自动浏览(新的在前):\n${lines.join('\n')}`,
  digestListLine: (id: string, what: string, posts: number, error?: string) => `- ${id}:${what},${error ? `没能运行(${error})` : `${posts} 条`}`,

  envPlatforms: (names: string[]) => (names.length ? names.join('、') : '(全部被关掉了)'),
  envImages: {
    ocr: '帖子里的图片在这台电脑上做 OCR,回执里给出识别出的文字。',
    model: `帖子里的图片直接附给你看(每次最多 ${ATTACHED_MAX} 张,其余做 OCR)。`,
    skip: '只读文字:带图片的帖子会被略过。',
  } as Record<ImageMode, string>,
  envAutoscroll: (lines: string[]) => (lines.length ? `已设置:\n${lines.join('\n')}` : '没有设置。'),
};

export type ModelText = typeof zh;

const en: ModelText = {
  platform: { reddit: 'Reddit', x: 'X', facebook: 'Facebook', threads: 'Threads', instagram: 'Instagram', youtube: 'YouTube', bilibili: 'Bilibili', rednote: 'Rednote' },
  source: (kind, query, sort, period) => {
    const order = [sort, period].filter(Boolean).join(', ');
    const base = kind === 'feed' ? 'feed' : kind === 'search' ? `search "${query}"` : kind === 'account' ? `account ${query}` : `community ${query}`;
    return order ? `${base} (${order})` : base;
  },
  duration: (ms) => {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ${s % 60} s`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
  },
  posts: (n, video) => `${n} ${video ? (n === 1 ? 'video' : 'videos') : (n === 1 ? 'post' : 'posts')}`,

  browseHead: (platform, what, posts, took) => `[social_browse] ${platform}, ${what}: ${posts} in ${took}.`,
  leftOut: (parts) => `Left out: ${parts.join(', ')}.`,
  leftVideo: (n) => `${n} video ${n === 1 ? 'post' : 'posts'} (videos are not read on this platform)`,
  leftImage: (n) => `${n} ${n === 1 ? 'post' : 'posts'} with images (text only)`,
  leftAd: (n) => `${n} ${n === 1 ? 'ad' : 'ads'}`,
  stopped: {
    count: 'It stopped at the number asked for.',
    time: 'It stopped at the time limit; there may be more.',
    end: 'The page showed no more.',
    interrupted: 'It was interrupted; this is what was read until then.',
  },
  generic: "Some posts were read by the generic reader (the page's layout was not recognized): authors, times and counts may be missing or mixed into the text.",
  used: (l) => `This request has used ${l.posts} of ${l.maxPosts} posts and ${l.sec} of ${l.maxSec} s (limits the person sets on the Social media page).`,
  ocrFailed: (why) => `OCR could not run (${why}); images were not read.`,
  nothing: 'Nothing was found.',

  postHead: (i, parts) => `[${i}] ${parts.join(' · ')}`,
  title: (t) => `Title: ${t}`,
  cut: (total) => `… (${total} characters in all; social_read shows the whole post)`,
  imageOcr: (n, text) => `Image ${n}, text read by OCR (may contain errors): ${text}`,
  imageOcrNone: (n) => `Image ${n}: OCR found no text.`,
  imageAlt: (n, alt) => `Image ${n}, the platform's description: ${alt}`,
  imageAttached: (n, k) => `Image ${n}: attached below as image ${k}.`,
  imageUnread: (n, why) => `Image ${n}: not read (${{ time: 'time limit reached', cap: `only the first ${IMAGES_PER_POST} images of a post are read`, download: 'download failed', decode: 'OCR could not decode the file', ocr: 'OCR could not run' }[why]}).`,
  attachedCaption: (k, post, image) => `image ${k}: post ${post}, image ${image}`,

  notRun: (tool, why) => `[${tool} not run] ${why}`,
  failed: (tool, why) => `[${tool} failed] ${why}`,
  platformOff: (platform) => `${platform} is turned off on the Social media page.`,
  noSource: (platform, kind, has) => `${platform} has no ${kind} listing; it has ${has.join(', ')}.`,
  needQuery: 'search, account and community need a query.',
  limitUsed: (l) => `This request's limit is used up (${l.posts} of ${l.maxPosts} posts, ${l.sec} of ${l.maxSec} s). Answer with what you have; the person can raise the limits on the Social media page.`,
  noBrowser: 'No Chromium-based browser (Chrome, Edge, Brave or Chromium) was found on this computer. The person can install one, or set its path on the Social media page.',
  noBrowserAt: (path) => `The browser path set on the Social media page does not exist: ${path}. The person can correct it, or clear it so the app finds a browser itself.`,
  loginWindowOpen: "A login window of the browser is still open; reading resumes once the person closes it (on a Mac, by quitting that browser with Cmd+Q).",
  blocked: (platform, id, kind, detail) => ({
    login: `${platform} asked for a login. Call social_login with ${id} to open a window where the person can log in.`,
    captcha: `${platform} showed a verification check. Call social_login with ${id} so the person can pass it in a window.`,
    consent: `${platform} asked about cookies first. Call social_login with ${id} so the person can answer in a window.`,
    blocked: `${platform} refused the request${detail ? ` (${detail})` : ''}; trying again later may work.`,
  })[kind],
  busy: (pages) => `The browser is reading in the background (${pages} ${pages === 1 ? 'page' : 'pages'}, the daily autoscroll); a window can open once that finishes.`,
  error: (message) => `Error: ${message}`,

  readHead: (platform, took) => `[social_read] ${platform}, in ${took}:`,
  readNone: 'The page held no post.',
  notPlatformUrl: 'This is not a link to one of the platforms: Reddit, X, Facebook, Threads, Instagram, YouTube, Bilibili, Rednote.',
  comments: (n) => `Top comments (${n}):`,
  comment: (author, text, score) => `- ${author}${score ? ` (${score})` : ''}: ${text}`,

  transcriptHead: (title, author, duration, language, generated) =>
    `[social_transcript] "${title}" — ${author} · ${duration} · captions: ${language}${generated ? " (generated by the platform's speech recognition)" : ''}`,
  transcriptSpan: (from, to, total, toEnd) => (toEnd ? `${from}–${to} (to the end):` : `${from}–${to} of ${total}:`),
  transcriptMore: (sec, max) => `Stopped at the per-call limit of ${max} characters. For the rest, call social_transcript again with from_sec ${sec}.`,
  noTranscript: (reason, title) => ({
    'no-captions': `"${title}" has no captions, so there is no transcript to read.`,
    login: `Bilibili shows the subtitles of "${title}" only to logged-in viewers. Call social_login with bilibili so the person can log in.`,
    unavailable: `The transcript of "${title}" could not be read (the video or its captions did not load).`,
  })[reason],
  notVideo: 'Transcripts exist for YouTube and Bilibili videos; give a video link or id.',
  untitled: 'this video',
  interruptedNothing: 'It was interrupted before anything was read.',

  loginOpened: (platform) => `[social_login] A browser window is open at the ${platform} login page. Tell the person to log in there and close the window when done; an event will say whether a login holds.`,
  loginEvent: (platform, holds) => `[social] The ${platform} login window was closed. ${holds ? 'A login holds.' : 'No login was found.'}`,

  statsHead: (since) => `[social_stats] Time spent reading each platform since ${since}:`,
  statsLine: (platform, took, posts, transcripts, last) =>
    `- ${platform}: ${took}, ${posts} posts or videos, ${transcripts} ${transcripts === 1 ? 'transcript' : 'transcripts'}${last ? `, last ${last}` : ''}`,
  statsNone: 'No platform has been read yet.',
  statsLogins: (yes, no) => `Logins: ${yes.length ? `logged in to ${yes.join(', ')}` : 'none'}${no.length && yes.length ? `; not logged in to ${no.join(', ')}` : ''}.`,
  statsJobs: (lines) => (lines.length ? `Daily autoscroll:\n${lines.join('\n')}` : 'Daily autoscroll: off.'),
  jobLine: (at, platform, what, posts, ranToday) => `- every day at ${at}: ${platform}, ${what}, ${posts} posts${ranToday ? ' (done today)' : ''}`,

  digestEvent: (what, posts, took, leftOut, id) =>
    `[social] The daily autoscroll of ${what} finished: ${posts} in ${took}. ${leftOut}The person set it up to get a summary: read the posts with social_digest (id "${id}") and tell them what matters, in your own words.`,
  digestFailed: (what, why) => `[social] The daily autoscroll of ${what} could not run: ${why}`,
  digestHead: (what, startedAt, total, from, to) => `[social_digest] ${what}, read ${startedAt}: posts ${from}–${to} of ${total}.`,
  digestNext: (offset) => `For the rest, call social_digest again with offset ${offset}.`,
  digestMissing: 'There is no digest with that id.',
  digestPastEnd: (total) => `The digest has ${total} posts; the offset is past its end.`,
  digestNone: 'The daily autoscroll has not run yet.',
  digestList: (lines) => `[social_digest] Saved daily autoscrolls, newest first:\n${lines.join('\n')}`,
  digestListLine: (id, what, posts, error) => `- ${id}: ${what}, ${error ? `could not run (${error})` : `${posts} posts`}`,

  envPlatforms: (names) => (names.length ? names.join(', ') : '(all turned off)'),
  envImages: {
    ocr: 'Images in posts are read with OCR on this computer; receipts give the text found.',
    model: `Images in posts are attached for you to see (up to ${ATTACHED_MAX} per call; the rest are read with OCR).`,
    skip: 'Text only: posts with images are left out.',
  },
  envAutoscroll: (lines) => (lines.length ? `Set up:\n${lines.join('\n')}` : 'Not set up.'),
};

export const MODEL_TEXT: Record<ModelLanguage, ModelText> = { zh, en };
