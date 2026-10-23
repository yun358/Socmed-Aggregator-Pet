# Socmed Aggregator Pet

A fork of [Coopanion](https://github.com/Pal-AI-Lab/Coopanion), the desktop pet, that scrolls social media so you don't have to. Everything else works as in Coopanion; see its README for setup.

## What this fork adds

- **Ask Coo about social media.** It reads Reddit, X, Facebook, Threads, Instagram, YouTube, Bilibili and Rednote in its own browser and answers in a speech bubble.
  - "What's happening on r/wallstreetbets?"
  - "What is MKBHD's latest video about?" Coo lists the videos, you pick one, and it summarizes the transcript.
  - "Find posts about Anime."
- **Limits per question**: how many posts and seconds Coo may spend (5 posts and 120 s by default).
- **Text-only mode**: skips posts with images to save tokens. Otherwise the text in images is read on your computer.
- **Daily autoscroll**: Coo reads a set number of posts each day and tells you what was in them.
- **Lifetime counter**: how much time Coo has spent on each platform.
- **Reply arrows**: ‹ and › on Coo's speech bubble to go back when it talks too fast.
- **Copy button**: copies Coo's whole reply, or just the text you selected.
- **Saved conversations**: start a new conversation or go back to an old one, as in a chat app. Ask Coo ("let's start a new conversation"), or use the **Conversations** page in settings. Coo can open your last 20 (set 0–100 there); older ones open from that page. Saving can be turned off there too.

The social media features are set up on the **Social media** page in settings. Some platforms need a login: click **Log in** there.

## Build

```bash
git clone --recursive https://github.com/yun358/Socmed-Aggregator-Pet.git
cd Socmed-Aggregator-Pet
pnpm install
pnpm run dev               # run it
pnpm run build:installer   # or build an installer into dist/
```

Don't accept the app's update offers: they install the official Coopanion, which doesn't have these features.

## License

AGPL-3.0, like Coopanion. See [LICENSE](LICENSE).
