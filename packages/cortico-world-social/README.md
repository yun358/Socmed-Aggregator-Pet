<!-- Owner: src/definition.ts -->

# cortico-world-social

[Cortico](https://github.com/Pal-AI-Lab/Cortico) 的社交媒体 World,随 Coopanion 打包。bot 用自己的浏览器替使用者浏览
Reddit、X、Facebook、Threads、Instagram、YouTube、哔哩哔哩、小红书与 Substack,在使用者设定的上限内读帖子、读视频文字稿,
用 OCR 读帖子图片里的文字,每天按设定自动浏览并交给 bot 写摘要,并累计在每个平台花的时间。bot 写的评论(Reddit、Substack)
与 Substack 短帖默认是草稿,由使用者在面板上发出;Substack 的文章只建草稿。

## 工具

| 工具 | 作用 | 回执 |
|---|---|---|
| `social_browse(platform, source, query?, sort?, period?, max_posts?)` | 列出帖子:`feed` 首页推荐、`search` 搜索、`account` 某账号的帖子、`community` 社区(Reddit 子版、Facebook 小组)。YouTube 与哔哩哔哩列出的是视频;其他平台的视频帖子略过 | 每条帖子的正文(列表里截到 1200 字)、图片的处理结果、链接;略过了什么、为什么停、这次请求用了多少 |
| `social_read(url, comments?)` | 打开一条帖子读全文与图片;Reddit、X、Threads、哔哩哔哩带热门评论 | 同上,算一条 |
| `social_transcript(video, from_sec?)` | YouTube 或哔哩哔哩视频的字幕文字稿,约 30 秒一段、带时间;超过 `maxTranscriptChars` 时写明从哪一秒续读 | 同一请求里同一个视频只算一条,续读从内存缓存取 |
| `social_login(platform)` | 用同一份资料目录单独启动浏览器(不受自动化控制),停在平台登录页,让使用者登录或完成验证;窗口开着时读取类工具拒绝执行 | 立即返回;窗口关掉后 `social.login` 事件写明登录是否生效 |
| `social_comment(url, text)` | 以使用者的名义给 Reddit 的帖子或评论、或 Substack 的文章写评论:草稿,或在自动评论、自动回复下排队 | 草稿 id,或排队后约何时发出;拒绝时写明原因 |
| `social_note(text, reply_to?)` | 写 Substack 短帖,或回复一条短帖(`reply_to` 给它的链接):草稿,或在自动短帖下排队 | 同上 |
| `social_draft(title, subtitle?, body)` | 在 `substack.publication` 的刊物里建立文章草稿,`body` 是 Markdown;不发布 | 草稿在 Substack 编辑器里的链接 |
| `social_stats()` | 累计用时、各平台读过的数量、上次检查的登录情况、每日自动浏览的设置 | — |
| `social_digest(id?, offset?)` | 分页读取每日自动浏览收集的帖子(每页约 8000 字),或列出保存的记录 | 不计入上限 |

所有工具都是 `interruptible`:被 interrupt 时返回已经读到的部分。

回执里来自平台的文字(正文、评论、标题、图片描述、OCR 文字、字幕)写不出回执或事件的行:帖子正文每行前加 `> `,其余收在标注它的那一行里
(换行写成 ` / `),每条评论最多 1000 字。环境提示词告诉 bot 这些是陌生人写的,不是给它的指令。

## 事件

| 类型 | 触发 | 内容 |
|---|---|---|
| `social.digest` | `flush`,等 bot 空闲(`onRunPhase` 为 `idle`)时才推送 | 每日自动浏览的一项读完:读到多少、略过了什么、摘要 id;或没能运行的原因 |
| `social.login` | 由 bot 打开的窗口为 `flush`,由设置页打开的为 `piggyback` | 登录窗口关掉后登录是否生效:平台的会话 Cookie,小红书与 Substack(访客也有这个 Cookie)再看页面 |
| `social.comment` | 发出为 `flush`,丢弃为 `piggyback` | 使用者在面板上发出了草稿(附链接与改动后的文字)或丢弃了它 |
| `social.reply` | `flush`,等 bot 空闲 | 自动回复开着时,Reddit 收件箱里的新回复 |
| `social.posted` | `piggyback` | 排队的帖子发出了(附链接),或改为草稿及其原因(开关被关掉、发出失败、使用者点了「暂不发出」) |
| `social.write` | `flush`,等 bot 空闲 | 到了当天计划的某条每日短帖的时间 |

## 每次请求的上限

一次请求就是 bot 的一轮:这一轮里所有 `social_browse`、`social_read`、`social_transcript` 用掉的条数与秒数加在一起,
与 `maxPosts`、`maxSec` 比较,`onTurnEnded` 时清零。用完后读取类工具拒绝执行,回执写明用量与上限;每份回执都带当时的上限,
因为环境提示词只在前缀重建时更新。时间从工具开始算起,浏览器启动也算在内;页面上的每一步(打开页面、等元素、页内 `fetch`)
等待不超过剩下的时间。

## 浏览器

`src/browser.ts` 用 playwright-core 驱动已安装的 Chrome、Edge、Brave 或 Chromium(`src/find-browser.ts` 按系统查找,
`browserFile` 可指定),用自己的资料目录 `<数据目录>/social-browser/`,与使用者平常的浏览器分开,登录一次后保留。
平时无界面运行(user agent 里的 `HeadlessChrome` 换成 `Chrome`),`showBrowser` 开着时有窗口;没有页面打开 3 分钟后关闭。
管道传输把浏览器的生命与 Core 绑在一起,Core 退出时浏览器随之退出。登录页(Google 登录等)拒绝受自动化控制的浏览器,
所以登录窗口是先关掉自动化的浏览器、再以普通进程在同一份资料目录上启动的浏览器;它开着时读取一律拒绝,`stop` 时结束它。

`fetchRaw`(帖子图片、字幕文件)在页面之外带浏览器的 Cookie 请求,所以只请求公网主机名上的 https(`publicHttps`:
不请求本机、局域网和 IP 地址;`http` 按 Chromium 的做法升级为 `https`),每次跳转都再检查一遍,超过 8 MB 的不读。
工具被 interrupt 时关掉页面,正在进行的一步立即结束。

适配器只经 `PageSession` 接触页面。页内函数由 `pageExpression` 序列化后送进页面:tsx 给函数加的 `__name` 在页面里由包装函数提供。

## 各平台

| 平台 | 列表 | 读取方式 | 需要登录 |
|---|---|---|---|
| Reddit | feed、search、account、community | 从 reddit.com 页面里请求 JSON 列表(`/r/<名>/<排序>.json` 等),按 `after` 翻页;置顶帖略过 | 需要:JSON 只回答登录的访客;401、403 记为要登录,已登录时 403 记为被拒(私密或封禁的子版) |
| X | feed、search、account | 页面上的 `article[data-testid="tweet"]`,滚动读取 | 需要 |
| Threads | feed、search、account | `div[data-pressable-container="true"]` | 搜索需要 |
| Instagram | feed、search(`#标签` 或关键词)、account | 账号与搜索走网页版自己用的 JSON(带 `x-ig-app-id`),被拒时逐个打开帖子页;feed 读页面 | 需要 |
| Facebook | feed、search、account、community(小组) | `[aria-posinset]`、`[role="feed"]` 的子元素或最外层 `[role="article"]`;读前展开「See more」 | 需要 |
| YouTube | feed、search、account(频道) | 页面数据 `ytInitialData`(含 `lockupViewModel`),滚动加载续页;频道视频页认不出时读频道的 RSS;搜索的排序与时间范围走 `sp` 参数 | feed 需要登录且有观看记录 |
| 哔哩哔哩 | feed、search、account(UP 主) | 从 bilibili.com 页面请求 Web API,`wbi/` 接口带 WBI 签名;UP 主列表被风控拒绝时读空间页 | AI 字幕需要 |
| 小红书 | feed、search、account(主页链接) | 列表卡片取自 `__INITIAL_STATE__`(或 DOM),每条笔记带卡片的 `xsec_token` 打开详情页读全文与图片,笔记之间停 2.5 秒 | 搜索需要;登录从页面判断 |
| Substack | feed、account(刊物、`@作者` 或 `me`)、community(类别) | 从页面请求 Substack 网页自己用的 JSON:刊物的 `/api/v1/archive`(`new` 或 `top`),作者的 `/api/v1/reader/feed/profile/<id>`(`notes` 或 `posts` 只取一种),类别的排行 `/api/v1/category/leaderboard/<id>/<trending 或 paid>` 及前 10 个刊物各自最受欢迎的 2 篇近期文章;刊物有自己的域名时,打开它的 substack.com 地址跟随跳转,链接留在 substack.com 上 | `me` 与写入需要;登录从 `/api/v1/user/profile/self` 判断 |

平台的版式会变。平台读取器在第一屏一条也没读到时,改用通用读取器(`readGenericPosts`:`article`、`role="article"`、
`aria-posinset`、`time[datetime]` 附近的块),回执写明有帖子是通用读取器读的。遇到登录页、验证页或 Cookie 选择页时抛出
`PlatformBlocked`,回执让 bot 调用 `social_login`。

视频文字稿:YouTube 只对带令牌的请求返回字幕,令牌由它自己的播放器生成,所以先让观看页的播放器加载字幕并读它发出的请求,
再试直接请求字幕轨道,最后打开文字稿面板;优先人工字幕,其次视频本身语言的自动字幕。哔哩哔哩从播放器接口取字幕列表,优先非 AI 字幕。

## 图片

`images` 决定帖子图片的处理:

- `ocr`(默认):在本机用 tesseract.js 识别文字,语言按应用语言加英文,哔哩哔哩与小红书再加简体中文;置信度低于 55 的行丢弃。
- `model`:把图片作为附件给模型看,每次最多 6 张,其余做 OCR;模型不接受该格式时也做 OCR。
- `skip`:只读文字,带图片的帖子整条略过;YouTube 与哔哩哔哩的视频不受影响。

每条帖子最多读前 4 张。平台自带的图片描述(alt)总会写进回执。Tesseract 解不开的图片只记这一张(`decode`),其余照读。OCR 的语言数据第一次用到时下载到 `<模型根>/social/`,
按固定的 SHA-256 校验,来源见 `THIRD_PARTY_NOTICES.md`。

## 每日自动浏览

`autoscroll.jobs` 每项是平台、来源、内容、每天的帖子数、本地时间 `HH:MM` 与图片处理方式;列表经面板的 `setJobs` 写入
(`/api/config` 写不了列表)。最多 8 项(`MAX_JOBS`),每项每天最多 300 条(`JOB_POSTS_CAP`);`images` 为 `model` 的项按 `ocr` 读,
因为摘要以文字保存。每 30 秒检查一次,到点且当天没运行过的项依次运行,应用当时没开着的,当天下次启动时补上;登录窗口开着时等它关掉。
一项开始运行时就记下当天已运行,出错也不会在同一天重复;World 停止时被打断的那一项不保存、不推送,记录恢复原样,下次照常运行。
每项最多 `autoscroll.maxMinutes` 分钟,读到的帖子存为摘要(`<数据目录>/social-digests/`,保留 14 天),然后推送 `social.digest`。
「立即运行」也记作当天的运行;清除记录只删摘要,不删运行日期。

## 评论与短帖

`comments.ts` 把草稿(最多 5 份,`DRAFTS_MAX`)、排队的帖子、发出过的(最后 50 条)、收件箱的查看记录与当天的每日短帖计划存在
`<数据目录>/social-comments.json`。草稿只能由使用者在面板上发出,用浏览器的登录经平台网站自己的接口(Reddit 的 `/api/comment`,
Substack 的 `/api/v1/comment/feed`、`/api/v1/post/<id>/comment`)。每天的上限(`comments.maxPerDay`、`substack.maxNotesPerDay`)
按本地日期数发出的与排在当天的。

自动评论、自动回复(回应 bot 一小时内被告知的回复)与自动短帖开着时,写出的内容排进队列:最早在 `FIRST_WAIT_MS` 到它的两倍之后,
并与同一平台同一种类的上一条(发出的或排队的)相隔 `GAPS`(评论 4 分钟,短帖 90 分钟)到它的两倍,随机取。每 30 秒看一次,
到时间的一次发出一条,`social.posted` 随下一批事件告诉 bot。带链接的、同一账号当天已自动回复 `REPLIES_PER_ACCOUNT` 次的不排队,
改为草稿;到时间时开关已关、发出失败或被打断(可能已经发出)的,也改为草稿。`comments.sign` 开着时自动发出的末尾加一行说明。

自动回复开着时每 5 分钟(`REPLY_CHECK_MS`)看一次 Reddit 收件箱(`/message/unread.json`,不标记已读),打开之前的、一天以前的、
自己的与 AutoModerator 的回复不告诉 bot。

`substack.dailyNotes` 大于 0 时,每天把 9:00–21:00 分成相等的几段,每段中间随机取一个时间(`planTimes`),到点时用 `social.write`
请 bot 写一条;应用关着错过一小时以上的不补。bot 为它写的短帖成为草稿时不打开设置窗口。

## 累计用时

`<数据目录>/social-lifetime.json` 记录自开始计数起每个平台的读取时间(从一次读取开始到结束,含每日自动浏览,不含使用者用登录窗口的时间)、
读过的帖子或视频数与文字稿数;最多每 5 秒写一次,`stop` 时写入。面板可以清零重新计数。

## 配置

`worlds.social`,每个键都在使用时读取。

| 键 | 默认 | 说明 |
|---|---|---|
| `maxPosts` | 5 | 一次请求最多读的帖子或视频数(1–100) |
| `maxSec` | 120 | 一次请求最多用的秒数(10–1800) |
| `images` | `ocr` | `ocr`、`model` 或 `skip` |
| `maxTranscriptChars` | 30000 | 文字稿每次最多返回的字数(2000–200000) |
| `showBrowser` | false | 读取时显示浏览器窗口 |
| `browserFile` | 空 | 浏览器可执行文件;空时自动查找 |
| `platforms.<id>.enabled` | true | 关掉的平台,工具拒绝执行,环境提示词里不列出 |
| `autoscroll.enabled` | false | 每日自动浏览的总开关 |
| `autoscroll.maxMinutes` | 15 | 每一项最多用的分钟数(1–120) |
| `autoscroll.jobs` | `[]` | 由面板的 `setJobs` 写入 |
| `comments.enabled` | false | bot 可以起草评论 |
| `comments.maxPerDay` | 10 | 每天最多发出的评论(1–50) |
| `comments.auto` | false | 自动评论 |
| `comments.autoReply` | false | 自动回复 Reddit 收件箱里的新回复 |
| `comments.sign` | true | 自动发出的评论与短帖末尾加一行说明 |
| `substack.publication` | 空 | 使用者的刊物:刊物名、name.substack.com 或它的域名;`social_draft` 的草稿放在这里 |
| `substack.notes` | false | bot 可以写短帖 |
| `substack.autoNotes` | false | 自动短帖 |
| `substack.maxNotesPerDay` | 3 | 每天最多发出的短帖(1–10) |
| `substack.dailyNotes` | 0 | 每天请 bot 写的短帖(0–5) |
| `substack.topic` | 空 | 每日短帖前先看的 Substack 类别 |

## 面板与存储

面板 `social`(`src/webui/client.ts`,构建为 `dist/webui.js`)显示等待处理的草稿、即将自动发出的帖子、上述设置、登录、每日自动浏览、
发出过的评论与短帖和累计用时;设置窗口的普通模式在「社交媒体」页挂载同一个面板。`invoke` 方法:`state`、`checkLogins`、`login`、
`setJobs`、`runNow`、`resetLifetime`、`commentPost`、`commentDiscard`、`queueHold`、`checkReplies`。
数据页签可以清除浏览器资料(各平台的登录)、OCR 语言数据与每日自动浏览的记录。

## 测试

`tests/` 下的解析与逻辑测试不需要浏览器;读取器与适配器的测试用真实的 Chromium,把所有请求路由到合成的页面与 JSON,
图片与字幕文件由本机 HTTP 服务提供(`context.request` 不经路由),找不到浏览器时跳过;也接受 `PLAYWRIGHT_BROWSERS_PATH` 下的 Chromium。
OCR 一例还要 `scratch/social-smoke/ocr/eng.traineddata`,没有时跳过。测试不访问网络。
