# Socmed Aggregator Pet

A desktop pet that scrolls social media so you don't have to. Ask Coo what is happening on a subreddit, what a YouTube video says, or what people post about a topic. It reads the posts in a browser of its own, within limits you set, and answers in a speech bubble.

This is a personal fork of [Coopanion](https://github.com/Pal-AI-Lab/Coopanion), the desktop pet by Pal-AI-Lab. Everything Coopanion does still works: voice and text chat, memory, computer use, figures and dress up. This fork adds social media reading and arrows for going back through Coo's replies.

<p align="center"><img src="image/README/pet-desktop-en.png" alt="Coo on the desktop" width="640"></p>

<p align="center">
  English ｜
  <a href="README_zh.md">简体中文</a>（Coopanion 完整说明，含本分支新增功能）
</p>

<p align="center">
  <img alt="Windows 10 / 11" src="https://img.shields.io/badge/Windows-10%20%2F%2011-1f6feb">
  <img alt="macOS 13+" src="https://img.shields.io/badge/macOS-13%2B-1f6feb">
  <img alt="Linux x64" src="https://img.shields.io/badge/Linux-x64-1f6feb">
  <a href="LICENSE"><img alt="AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-8b8b8f"></a>
</p>

- [What you can ask](#what-you-can-ask)
- [Platforms](#platforms)
- [The Social media page](#the-social-media-page)
- [Reply arrows](#reply-arrows)
- [Install](#install)
- [Build from source](#build-from-source)
- [Cost and privacy](#cost-and-privacy)
- [Things to know](#things-to-know)
- [Credits and license](#credits-and-license)

## What you can ask

| You ask | Coo |
|---|---|
| "What's happening on r/wallstreetbets?" | reads the subreddit's hot posts (5 by default) and sums them up |
| "What is MKBHD's latest video about?" | lists the channel's newest videos; you pick one, Coo reads its transcript and summarizes it |
| "What's going on with the riots in France? Find me some videos." | searches YouTube and recommends videos from the results |
| "Find Instagram posts about Japanese restaurants in Singapore." | searches, reads the text and image posts (the text in images is recognized on your computer), sums them up and links the posts |
| "What's new in my Reddit feed today?" | reads your own feed once you have logged in |
| "How much time have you spent on Reddit?" | reads the lifetime counter |

Links to posts in Coo's bubbles can be clicked. Coo can also ask a platform for newest, top or most viewed posts, and for a time period on Reddit's top posts and on YouTube search. On Reddit, X, Threads and Bilibili it reads a post's top comments when it opens the post.

On platforms other than YouTube and Bilibili, video posts are left out; Coo reads text and image posts.

## Platforms

| Platform | What Coo can read | Login |
|---|---|---|
| Reddit | home feed, search, a user's posts, a subreddit | required |
| X | home timeline, search, an account | needed to see much |
| Facebook | news feed, post search, a page or profile, a group | needed to see much |
| Threads | feed, search, an account | needed to see much |
| Instagram | feed, search (`#tag` or keywords), an account | needed to see much |
| YouTube | home feed, search, a channel; video transcripts | the home feed needs a login with watch history |
| Bilibili | recommendations, search, an uploader; video subtitles | AI subtitles need a login |
| Rednote | explore feed, search, a profile (by its link) | search needs a login |

Transcripts come from a video's captions or subtitles; a video without them has no transcript.

Coo uses Chrome, Edge, Brave or Chromium installed on your computer, with a profile of its own, so your own browser and its logins are not touched. Windows comes with Edge; on macOS and Linux, install Chrome or Chromium if the Social media page says no browser was found, or enter the path of one there.

**Logging in**: click **Log in** beside a platform on the Social media page, or ask Coo. Coo's browser opens in a window of its own at the login page; log in, then close the window (on a Mac, quit that browser with Cmd+Q). Coo reads nothing while the window is open. When a platform asks you to pass a check or choose cookies, Coo opens the window the same way. Logins stay in Coo's browser profile.

## The Social media page

Open the settings window (the tray icon, or right-click Coo) and go to **Social media**.

- **Each request**: how many posts (5 by default, up to 100) and how many seconds (120 by default, up to 1800) Coo may spend on one message of yours, all its reads together. When a limit stops it, Coo tells you what it has and that you can raise the limit.
- **Images**:
  - **Read text** (default): the text in images is recognized on your computer. The language data for English and for the app language, under 3 MB each, downloads on first use.
  - **Show to Coo**: the model sees the images and understands pictures without text too; costs more.
  - **Text only**: posts with images are left out; uses the fewest tokens.
- **Transcripts**: how many characters of a transcript Coo reads at once (30,000 by default); a longer one is read in parts.
- **Platforms**: turn on the platforms Coo may read, see which ones are logged in, and log in.
- **Browser**: the browser Coo uses, and **Show the browser** to watch it read.
- **Daily autoscroll**: turn it on and add up to 8 jobs. Each job is a platform; its feed, a search, an account or a community; what to read; how many posts a day (up to 300); a time; and, if you like, text only (otherwise the text in its images is read). Each job runs once a day from its time, or at the next start that day if the app was closed then, for at most 15 minutes by default. Once Coo is free, it tells you what was in the posts. **Run now** runs a job at once and counts as its run for that day. Runs are kept for 14 days.
- **Lifetime counter**: how long Coo has spent on each platform since the counter started, with the posts and transcripts it read and when it last read there. The daily autoscroll counts; time you spend in a login window does not. **Reset counter** starts it again from zero.

## Reply arrows

When Coo talks faster than you read, go back. Coo keeps the text of its last 50 speech bubbles, and a speech bubble shows ‹ and › with a position such as `3/7`:

- ‹ shows the bubble before in full; › the one after. Past the newest, the bubble Coo was showing comes back.
- The number after the position counts the bubbles still to come (`3/7 +2`). They wait while you look back or while the pointer is on the bubble; › shows the next one at once.
- A speech bubble stays while the pointer is on it.
- Looking back ends on Esc, when the typing box opens, when Coo asks you something, and after 8 seconds with the pointer off the bubble.
- After the bubble has closed, the past-replies button (a clock with a back arrow) in the right-click menu or the hover buttons opens the newest again.

Turn the arrows off with **Reply arrows** on the Habits page.

## Install

You need:

- Windows 10 / 11 (64-bit), macOS 13 or later, or a 64-bit Linux desktop;
- an API key from one model service (OpenAI, Anthropic, Gemini, xAI, OpenRouter, DeepSeek, Kimi, Qwen, MiniMax, Zhipu GLM, Doubao, Baidu Qianfan or StepFun), or a ChatGPT account with a plan;
- Chrome, Edge, Brave or Chromium for social media.

This repository publishes no downloads, and the official Coopanion downloads do not include this fork's changes; build the installer from source (below). On Windows:

1. Run `Coopanion-Setup-<version>.exe`. The installer is not code-signed, so Windows may show "Windows protected your PC": click **More info** → **Run anyway**.
2. Pick a folder (default `C:\Users\<you>\Coopanion`) and install. Coopanion starts when done, and a desktop icon is added. The program and its data stay in that folder.
3. On first start Coo walks you through setup in its bubbles: what to call you, its personality, how much it walks around, the model service and API key, and the speech model.

> [!WARNING]
> The app's updater checks the official Coopanion releases. Accepting an update replaces this fork with the official version, which has no social media reading. This fork keeps the official version number (0.2.6), so installing it over an existing Coopanion keeps your data.

For macOS and Linux, and for everything else about setting up and using Coopanion, see the [Coopanion README](https://github.com/Pal-AI-Lab/Coopanion#readme).

## Build from source

You need Git, Node.js 22 and pnpm (`corepack enable`).

```bash
git clone --recursive https://github.com/yun358/Socmed-Aggregator-Pet.git
cd Socmed-Aggregator-Pet
pnpm install
pnpm run dev                 # builds and starts the app; its data goes to build/data
```

If you cloned without `--recursive`, fetch the Cortico submodule with `git submodule update --init --recursive`.

| Command | What it does |
|---|---|
| `pnpm run build:installer` | builds the installer for the platform it runs on: `dist/Coopanion-Setup-<version>.exe` on Windows, a dmg and zip on macOS, an AppImage and deb on Linux |
| `pnpm run test` and `pnpm run test:worlds` | unit tests; the social media World's browser tests use a local Chrome, Edge, Brave or Chromium and are skipped without one. No test reaches a real platform |
| `pnpm run typecheck`, `typecheck:web`, `typecheck:worlds` | type checks |

The social media World is in [`packages/cortico-world-social`](packages/cortico-world-social); its README (Chinese) describes how each platform is read. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (Chinese) covers the rest of the code.

## Cost and privacy

- **Cost**: Coopanion is free. The model service you choose bills you for usage, and every post Coo reads adds to it. The per-request limits and **Text only** keep it down.
- **Sent to the model service**: what you say and type, and the text of the posts, comments and transcripts Coo reads (with **Show to Coo**, their images too).
- **Kept on your computer**: Coo's browser profile with your platform logins, the language data for reading text in images, the daily autoscroll's saved posts and the lifetime counter. The first three can be cleared on the social media World's **Data** tab in the advanced mode.
- **Network access added by this fork**: the platforms Coo reads, from its own browser, when you ask and in the daily autoscroll; jsDelivr, unpkg or npmmirror for the text recognition's language data. Coopanion's own network access (update checks, anonymous usage statistics that can be turned off in Habits, speech model downloads) is listed in its README.

## Things to know

- **Your accounts**: automated reading can break a platform's terms of use, and a platform can rate-limit, challenge or flag an account that Coo logs into. Use an account you can afford to lose.
- **Platforms change their pages**: when Coo does not recognize a page, it reads it with a general reader, which can miss authors, times and counts. Reading a platform can stop working until the code is updated. The tests use made-up pages, so a platform's real pages may need adjustments on first use.
- **Instructions in posts**: Coo is told that what it reads from platforms is written by strangers and is never an instruction to it.
- **Daily autoscroll and images**: jobs read the text in images or skip them; they cannot show images to Coo, because their posts are saved as text.

## Credits and license

Based on [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) by Pal-AI-Lab, built on [Cortico](https://github.com/Pal-AI-Lab/Cortico). Licensed under the GNU Affero General Public License v3 with the additional permission in [LICENSE](LICENSE); this fork's changes are under the same license.
