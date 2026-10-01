# Telegram Media Dashboard

A responsive web dashboard for sending many images and videos to a Telegram chat in neat albums ("packs"). This repository is the **frontend + API gateway**: a static site and a Cloudflare Worker, deployed together with `wrangler deploy` (Pages is optional). The Telegram bot token is **never** here; it lives only on the private bot server ([`telegram-media-bot-server`](../telegram-media-bot-server)).

```text
Browser → Cloudflare (static site + Worker API, one `wrangler deploy`)
        → Worker /api/*          (this repo, worker.js)
        → Private Bot Server     (telegram-media-bot-server)
        → Telegram Bot API
```

## 1. What it does

- Select images/videos (or drag and drop), see thumbnails, names and sizes
- Remove files, clear all, reorder (drag cards, or use the ◀ ▶ buttons on mobile)
- Pack size 5–10 (default 10); files are shown grouped by pack
- Optional caption (added to the first item of every pack)
- Progress: files sent / total, current pack, success and error status, API connection status
- Each pack is uploaded as its own request, so a failure part-way keeps the unsent files in the list and you can press **Send** again to continue

## 2. Project structure

```text
telegram-media-dashboard/
├── public/              static website, served by the Worker (no build step)
│   ├── index.html
│   ├── styles.css
│   ├── app.js           <- set WORKER_URL here
│   └── _headers         security headers for the static site
├── worker.js            Cloudflare Worker (API gateway + serves public/)
├── wrangler.toml        Worker + static assets config
├── .dev.vars.example    local secrets template
├── package.json
├── README.md
├── .gitignore
└── LICENSE
```

## 3. Local development

```bash
npm install
cp .dev.vars.example .dev.vars     # set INTERNAL_API_KEY (must equal the bot server's key)
npx wrangler dev                    # website + API at http://localhost:8787
```

Start the bot server too (see its README) and open http://localhost:8787.

## 4. Deploy (one command)

The website (`public/`) and the API (`worker.js`) are deployed together as **one Worker**:

```bash
npm install
npx wrangler login
npx wrangler deploy
```

Wrangler prints your URL, e.g. `https://telegram-media-dashboard.<your-subdomain>.workers.dev`. Open it: that is the dashboard, and `/api/*` on the same URL is the API.

Deploying from Git instead: Cloudflare dashboard → *Workers & Pages* → *Create* → *Import a repository*, build command empty, deploy command `npx wrangler deploy`.

> **Do not drag this repository into the Cloudflare Pages "Upload assets" box.** That uploader rejects projects with a `wrangler.toml` ("does not yet support projects that require a build process…"). Use `wrangler deploy`, or see section 7.

## 5. Worker secrets

Run after the first deploy:

```bash
npx wrangler secret put BOT_SERVER_URL      # e.g. https://bot.example.com   (no trailing slash)
npx wrangler secret put INTERNAL_API_KEY    # long random string, identical to the bot server's INTERNAL_API_KEY
```

Generate a key with `openssl rand -hex 32`. Optional variables in `wrangler.toml` `[vars]`:

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_ORIGIN` | `*` | CORS allow-list for *other* sites. Same-origin requests are always allowed. Set it (comma-separated) if the site is hosted elsewhere. |
| `MAX_BODY_MB` | `95` | Max request size accepted by the Worker. |
| `RATE_LIMIT_PER_MINUTE` | `60` | Per-IP limit (best effort, per Worker isolate). |

## 6. Where the Worker URL is configured

Open `public/app.js`; the configuration block is at the very top:

```javascript
const WORKER_URL = "";
```

- `""` (default) means "the API is on the same site". Correct for `wrangler deploy`; nothing to change.
- If the website is hosted elsewhere, set it to your Worker URL, e.g. `const WORKER_URL = "https://YOUR-WORKER.workers.dev";` (no trailing slash).

The same block holds the limits (`MAX_FILE_MB`, `MAX_REQUEST_MB`, …).

## 7. Optional: host the website on Cloudflare Pages

Only if you want the site and API on different URLs:

1. `npx wrangler deploy` (the Worker; its URL still serves the site too).
2. Set `WORKER_URL` in `public/app.js` to that Worker URL.
3. In Cloudflare Pages choose *Upload assets* and upload **only the `public` folder** (not the repository root), or connect Git with build command empty and output directory `public` on a copy of the repo without `wrangler.toml`.
4. Set `ALLOWED_ORIGIN` in `wrangler.toml` to your Pages URL and run `npx wrangler deploy` again.

## 8. Connect to the bot server

1. Deploy the bot server and note its public HTTPS URL.
2. Put that URL in the `BOT_SERVER_URL` secret.
3. Use the same `INTERNAL_API_KEY` on the Worker and the bot server.
4. Open the dashboard: the badge should read **Connected**. "API up, bot server unreachable" means the Worker works but cannot reach `BOT_SERVER_URL/health`.

## 9. Security

- The Telegram token and chat ID exist only on the bot server. The browser only ever talks to the Worker.
- The Worker adds `X-Internal-Key` to every call to the bot server; the bot server rejects anything without it.
- The Worker validates content type, request size, `packSize`, and CORS origin, adds security headers, and rate-limits per IP (best effort; for strict limits add a Cloudflare WAF rate-limiting rule).
- **The dashboard itself has no login.** Anyone who can open the dashboard URL can post to your Telegram chat. Protect it with **Cloudflare Access** (free for small teams) or keep the URL private.
- Never put secrets in `app.js`, `wrangler.toml`, or Git. `.dev.vars` is git-ignored.

## 10. Limits (please read)

This design does **not** support unlimited sizes.

- **Cloudflare:** a request body to a Worker is capped at 100 MB on Free/Pro (200 MB Business, 500 MB Enterprise). The dashboard sends one pack per request, and refuses a pack larger than `MAX_REQUEST_MB` (95). Large videos therefore need a smaller pack size.
- **Telegram (standard Bot API):** files up to 50 MB, photos up to 10 MB, albums of 2–10 items, captions up to 1024 characters, and roughly 20 messages per minute to a group. The bot server handles `retry_after` automatically.
- **Formats:** photos JPEG/PNG/WebP/GIF; videos MP4/MOV/WebM (MP4/H.264 works best). HEIC/AVIF are rejected.
- A lone leftover file (e.g. 11 files with pack size 10) is sent as a single photo/video because Telegram albums need at least two items.

**Optional future architecture for very large batches** (not needed for this project): browser → direct upload to **Cloudflare R2** (presigned URLs) → **Cloudflare Queues** message per pack → bot worker/server pulls files from R2 and sends them to Telegram, removing the per-request size cap and enabling retries in the background.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Cloudflare Pages uploader says "does not support projects that require a build process" | Use `npx wrangler deploy` instead (section 4), or upload only the `public` folder (section 7). |
| Badge says "Set WORKER_URL in app.js" | `WORKER_URL` is invalid. Use `""` or the full Worker URL. |
| "API unreachable" | Wrong Worker URL, Worker not deployed, or `ALLOWED_ORIGIN` doesn't include your site URL (only when the site is hosted separately) (check the browser console for CORS errors). |
| "API up, bot server unreachable" | `BOT_SERVER_URL` is wrong, server is down, or it is not on HTTPS port 443/80 (Workers restrict some ports). Test `curl https://bot.example.com/health`. |
| "Bot server rejected the Worker" | `INTERNAL_API_KEY` differs between Worker and bot server. Re-run `wrangler secret put`. |
| 413 / "above the 95 MB limit" | Reduce pack size or remove large files. |
| 429 | Too many requests; wait a minute. |
| Telegram errors ("chat not found", …) | Fix `TELEGRAM_CHAT_ID`/bot permissions on the bot server; see its README. |
| "The entry-point file at … was not found" | `wrangler.toml` and `worker.js` must be at the top level of the repo (not inside an extra folder). In a Cloudflare Git build set *Settings → Build → Root directory* if they are in a subfolder. |
| Secrets changed but no effect | Run `npx wrangler deploy` again after `secret put`. |

## License

MIT
