# Socmed Aggregator Pet

A desktop pet that scrolls social media so you don't have to. Ask Coo a question, and it reads the posts in a browser of its own and answers in a speech bubble.

A personal fork of [Coopanion](https://github.com/Pal-AI-Lab/Coopanion). Everything Coopanion does still works; see its README for general setup and use. [简体中文](README_zh.md) has the full manual.

## What it adds

- **Social media reading**: Reddit, X, Facebook, Threads, Instagram, YouTube, Bilibili and Rednote.
  - "What's happening on r/wallstreetbets?": Coo reads the hot posts and sums them up.
  - "What is MKBHD's latest video about?": Coo lists the newest videos, you pick one, and it summarizes the transcript.
  - "Find posts about Japanese restaurants in Singapore": Coo searches, reads text and image posts, and links the best ones.
- **Limits**: set how many posts (default 5) and seconds (default 120) Coo may spend on each question.
- **Text-only mode**: skip posts with images to save tokens. Otherwise the text in images is read on your computer.
- **Daily autoscroll**: Coo reads a set number of posts each day at a set time and tells you what was in them.
- **Lifetime counter**: how much time Coo has spent on each platform.
- **Reply arrows**: ‹ and › under Coo's speech bubble to go back through its replies when it talks too fast.
- **Copy**: the copy button on Coo's speech bubble copies the whole reply, or just the text you selected in the bubble.

Set everything up on the **Social media** page of the settings window. Some platforms need a login: click **Log in** there, log in in the window that opens, then close it.

## Install

You need Windows 10/11, macOS 13+ or 64-bit Linux, Chrome, Edge, Brave or Chromium, and an API key from a model service (or a ChatGPT plan).

Build from source with Git, Node.js 22 and pnpm:

```bash
git clone --recursive https://github.com/yun358/Socmed-Aggregator-Pet.git
cd Socmed-Aggregator-Pet
pnpm install
pnpm run dev               # run it
pnpm run build:installer   # or build an installer for your platform into dist/
```

Don't accept the app's update offers: they install the official Coopanion, which doesn't have these features.

## Good to know

- Automated reading may break a platform's terms; an account Coo logs into could be flagged.
- Platforms change their pages, so reading one can break until the code is updated.
- The text of the posts Coo reads is sent to your model service.

## License

AGPL-3.0, like Coopanion. See [LICENSE](LICENSE).
