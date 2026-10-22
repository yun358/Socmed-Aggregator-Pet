import { join } from 'node:path';
import type { Language } from 'cortico/core/language.ts';
import { modelsRoot } from 'cortico/paths.ts';
import { describeTools, type WorldDefinition, type WorldDescribe } from 'cortico/world.ts';
import { SOCIAL_DEFAULTS, SOCIAL_ID, type SocialConfigSection } from './config.ts';
import { socialText } from './i18n/index.ts';
import type { ModelLanguage } from './model-text.ts';
import { SOCIAL_TOOL_DECLS } from './tools.ts';
import { SocialWorld } from './world.ts';

const DESCRIBE: WorldDescribe = {
  tools: describeTools([...SOCIAL_TOOL_DECLS], {
    social_browse: { zh: '在 Coo 自己的浏览器里列出某个平台的帖子或视频:首页推荐、搜索、账号或社区,受每次请求的上限约束。', en: "Lists a platform's posts or videos in Coo's own browser: its feed, a search, an account or a community, within the per-request limits." },
    social_read: { zh: '打开一条帖子读全文、图片与热门评论。', en: 'Opens one post for its full text, images and top comments.' },
    social_transcript: { zh: '读 YouTube 或哔哩哔哩视频的字幕文字稿,长的分次读。', en: 'Reads the caption transcript of a YouTube or Bilibili video, a long one in parts.' },
    social_login: { zh: '打开浏览器窗口到某个平台的登录页,让使用者登录或完成验证。', en: "Opens a browser window at a platform's login page for the person to log in or pass a check." },
    social_stats: { zh: '累计用时:各平台浏览的时间与读过的数量,登录情况,每日自动浏览的设置。', en: 'The lifetime counter: time and reads per platform, logins, and the daily autoscroll jobs.' },
    social_digest: { zh: '分页读取每日自动浏览收集的帖子,或列出保存的记录。', en: 'Reads the posts a daily autoscroll run collected, a page at a time, or lists the saved runs.' },
  }),
  events: [
    {
      type: `${SOCIAL_ID}.digest`,
      description: { zh: '每日自动浏览读完了一项(或没能运行),说明读到多少与摘要的 id。', en: 'A daily autoscroll job finished (or could not run), with what it read and its digest id.' },
      trigger: 'flush',
    },
    {
      type: `${SOCIAL_ID}.login`,
      description: { zh: '登录窗口关掉了,说明登录是否生效;在设置窗口打开的窗口随下一批事件送达。', en: 'A login window was closed, with whether a login holds; piggybacks when the window was opened from the settings window.' },
      trigger: 'flush',
    },
  ],
};

export interface SocialAssembly {
  /** The language of what the bot reads from this World, read at each use; Chinese when absent. */
  modelLanguage?(): ModelLanguage;
  /** The app language, what the person reads; OCR languages follow it. */
  language?(): Language;
  /** Called with each World instance Core creates. */
  onCreate?(world: SocialWorld): void;
}

/** The definition, with what an embedding app lends the World. */
export function socialDefinition(assembly: SocialAssembly = {}): WorldDefinition<SocialConfigSection> {
  return {
    id: SOCIAL_ID,
    // read when Core assembles the Worlds, in the app language of that moment
    get label() { return socialText(assembly.language?.()).console.label; },
    defaults: () => structuredClone(SOCIAL_DEFAULTS),
    create: (ctx) => {
      const world = new SocialWorld({
        cfg: ctx.cfg,
        timezone: ctx.timezone,
        dataDir: ctx.dataDir,
        ocrDir: join(modelsRoot(), SOCIAL_ID),
        persist: (patch) => ctx.persist(patch),
        modelLanguage: () => assembly.modelLanguage?.() ?? 'zh',
        language: () => assembly.language?.() ?? 'zh',
      });
      assembly.onCreate?.(world);
      return world;
    },
    describe: DESCRIBE,
  };
}

export const SOCIAL = socialDefinition();
