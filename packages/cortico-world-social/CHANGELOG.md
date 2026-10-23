## Unreleased

- `social_comment` drafts comments on Reddit posts and comments, posted only from the panel (`commentPost`, `commentDiscard`); `social.comment` tells the bot what the person did. `comments.*` in the config.
- Automatic comments and automatic replies: the bot's comments, and its answers to new replies in the Reddit inbox (`social.reply`), go out on their own, queued and spaced (`FIRST_WAIT_MS`, `GAPS`); `social.posted` tells the bot when one went out or became a draft; the panel's `queueHold` keeps one back.
- Substack: `social_browse` reads the feed, a publication's archive, a person's Notes and posts (`@handle`, `me`) and a category's leaderboard; `social_read` reads a post with its comments; `social_comment` comments on posts; `social_note` writes Notes and replies to Notes; `social_draft` creates post drafts in `substack.publication`, never published. Daily Notes at random times (`social.write`). `substack.*` in the config.

## 0.1.0

- First version: `social_browse`, `social_read`, `social_transcript`, `social_login`, `social_stats` and `social_digest` over Reddit, X, Facebook, Threads, Instagram, YouTube, Bilibili and Rednote, read in an installed Chromium-based browser with its own profile; per-request limits on posts and seconds; OCR of post images with tesseract.js, images shown to the model, or text only; a daily autoscroll whose digests the bot reads; a lifetime counter per platform; the `social` panel.
