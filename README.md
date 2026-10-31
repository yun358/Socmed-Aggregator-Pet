# Socmed Aggregator Pet

A fork of [Coopanion](https://github.com/Pal-AI-Lab/Coopanion), the desktop pet, that scrolls social media so you don't have to. Everything else works as in Coopanion; see its README for setup.

## What this fork adds

- **Ask Coo about social media.** It reads Reddit, X, Facebook, Threads, Instagram, YouTube, Bilibili, Rednote and Substack in its own browser and answers in a speech bubble.
  - "What's happening on r/wallstreetbets?"
  - "What is MKBHD's latest video about?" Coo lists the videos, you pick one, and it summarizes the transcript.
  - "Find posts about Anime."
- **Limits per question**: how many posts and seconds Coo may spend (5 posts and 120 s by default).
- **Text-only mode**: skips posts with images to save tokens. Otherwise the text in images is read on your computer.
- **Daily autoscroll**: Coo reads a set number of posts each day and tells you what was in them.
- **Lifetime counter**: how much time Coo has spent on each platform.
- **Comments on every platform**: ask Coo to comment on a post or video on any of the nine platforms, or to reply to a comment on Reddit, X, Threads or Bilibili (give it the comment's link), and it writes a draft; you edit it if you like and post it yourself from the **Social media** page. Off until you turn it on there, at most 10 a day by default.
- **Automatic comments and replies**: two more switches there. One posts Coo's comments without waiting for you, a few minutes apart; the other has Coo answer replies to your Reddit comments and posts on its own. What's about to go out is listed at the top of the page, where **Hold** keeps it back as a draft. Comments with links still wait for you. These platforms can limit or ban accounts that post automatically.
- **New posts**: ask Coo to post on X, Threads, Reddit (it writes the title too, which you can edit) or Bilibili. Each waits as a draft unless you turn on **Automatic posts**, which posts them at least an hour apart on each platform. Instagram, YouTube and Rednote need a picture or a video, so Coo doesn't post there.
- **How it writes**: on X, Threads, YouTube, Facebook and Rednote, Coo types into the site's own page in its browser, as you would; on the others it uses the requests the site's own pages make. Writing has been tested against copies of these pages, not the live sites, and breaks when a site changes.
- **Substack**: Coo reads your feed, a publication's posts, anyone's Notes and posts (@handle), and the leaderboard of a category such as Technology, with what does best there. Ask it to write a Note, reply to one or comment on a post; each waits for you unless you turn on **Automatic Notes**, which posts them at least 90 minutes apart. **Daily Notes** has Coo write up to 5 Notes a day at random times, in your voice after reading your recent ones. Set your publication and Coo can put post drafts there; it never publishes them. Substack has no public API, so this uses the requests Substack's own pages make and can break when they change; Substack can remove accounts for inauthentic activity.
- **Balance bubble**: rest the pointer on Coo, or poke it, and a small bubble beside it shows how much is left on your model account. Works with DeepSeek and Kimi, and with an OpenRouter key that has a credit limit; other services show no balance.
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
