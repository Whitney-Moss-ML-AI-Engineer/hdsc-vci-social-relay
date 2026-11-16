# hdsc-vci-social-relay

The small cloud function that lets the HDSC VC Intelligence apps (desktop, web, phone) post to your own social accounts, send one-to-one emails and X messages, and pull designs from Canva. It runs on your own free Cloudflare account. Nobody else can use it: every call needs your relay key.

It is the fourth isolated project next to hdsc-vci-crm, hdsc-vci-web and hdsc-vci-mobile. The apps talk to it only over HTTPS (`/v1/...`).

## What it can and can't do

| App | What you can do from HDSC VC Intelligence | Limits set by the platform |
|---|---|---|
| LinkedIn | Post text and images to your profile (or HDSC Company Page with `LINKEDIN_ORG_ID`) | LinkedIn has no messaging API. Investor messages on LinkedIn stay copy → open → you send → "I sent it". |
| Gmail / Outlook | Send one email to one investor after you press Send | Address must come from your file or a source link; opt-out line required; 40/day cap |
| X | Post with an image; send a DM to an @handle | DMs only reach people who accept messages from you; 20/day cap; X's paid API tier |
| Facebook | Post text, image or video to your Page | Page posts only (no personal profile posting API) |
| Instagram | Post an image or Reel to your professional account | Needs a Business or Creator account linked to your Facebook Page. Instagram DMs can only answer people who wrote first, so they are not offered. |
| TikTok | Send a video or photo to your TikTok inbox to finish in the app (default), or post directly | Until TikTok audits your app, direct posts are private ("only me"). Photo posts need this relay's address verified in the TikTok portal. |
| Canva | Browse your designs, open a new design at a social size, export PNG/JPG/MP4 for posting | Canva Connect API integration |

Nothing is sent on a schedule or in bulk. One press of Send in the app = one post or one message.

## Set up (about 30 minutes for the relay, plus each app's developer sign-up)

1. Install Node 20+ and run `npm install` in this folder.
2. `npx wrangler login` (opens Cloudflare; a free account is fine).
3. `npx wrangler kv namespace create STORE` and paste the id into `wrangler.toml`.
4. Generate two secrets and store them:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # relay key → RELAY_OWNER_TOKEN
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # → TOKEN_KEY
   npx wrangler secret put RELAY_OWNER_TOKEN
   npx wrangler secret put TOKEN_KEY
   ```
5. `npx wrangler deploy`. Put the address it prints (for example `https://hdsc-vci-social-relay.<you>.workers.dev`) in `PUBLIC_URL` in `wrangler.toml` and deploy again.
6. In each app, open **Connections → Relay**, paste the address and the relay key.
7. For each app you want, create a developer app, set its redirect URL to `PUBLIC_URL/v1/callback/<name>`, and store its keys with `npx wrangler secret put`:

| App | Where | Redirect URL ends with | Secrets |
|---|---|---|---|
| LinkedIn | linkedin.com/developers → Create app → Products: "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn" | `/v1/callback/linkedin` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| Gmail | console.cloud.google.com → APIs: Gmail API → OAuth client (Web) | `/v1/callback/google` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Outlook | entra.microsoft.com → App registrations (any account type) → Web platform | `/v1/callback/microsoft` | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` |
| X | developer.x.com → Project → App → User authentication: OAuth 2.0, Web App (confidential) | `/v1/callback/x` | `X_CLIENT_ID`, `X_CLIENT_SECRET` |
| Facebook + Instagram | developers.facebook.com → Create app (Business) → Facebook Login for Business, Instagram Graph API | `/v1/callback/meta` | `META_APP_ID`, `META_APP_SECRET` |
| TikTok | developers.tiktok.com → Manage apps → Login Kit + Content Posting API | `/v1/callback/tiktok` | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` |
| Canva | canva.com/developers → Your integrations → Create (Public or Private) → Scopes: design read/write, profile read | `/v1/callback/canva` | `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET` |

8. Optional: `npx wrangler secret put ANTHROPIC_API_KEY` turns on the "Polish" button in the script generator. It rewrites tone only and never adds facts.
9. Add any browser origin that will call the relay (the hosted web app) to `ALLOWED_ORIGINS`. The desktop app and the phone app need nothing here.

While your Meta, TikTok and LinkedIn Company Page apps are in development mode they work for your own accounts, which is all this relay needs. Meta needs app review only if other people will use your app.

## Security

- Every route except the OAuth callback and TikTok photo pulls requires `Authorization: Bearer <RELAY_OWNER_TOKEN>` (compared in constant time, minimum 32 characters).
- Provider tokens are encrypted with AES-256-GCM (`TOKEN_KEY`) before they are written to KV. OAuth `state` values are random, single-use and expire in 10 minutes; PKCE is used wherever the provider supports it.
- Browser CORS is limited to `ALLOWED_ORIGINS` plus the desktop app's `app://bundle` origin.
- Email: one recipient per request, address source required, opt-out line required, no header injection, daily caps. Every post and message is recorded in a 500-entry log (`GET /v1/log`).
- No scraping and no browser automation of any site.

## API

| Method | Path | Body / query |
|---|---|---|
| GET | `/v1/health` | — |
| GET | `/v1/accounts` | — |
| POST | `/v1/connect/{provider}` | — → `{ url }` to open in the browser |
| DELETE | `/v1/accounts/{provider}` | — |
| GET | `/v1/canva/designs` | `query`, `continuation` |
| POST | `/v1/canva/designs` | `{ size: square|portrait|story|landscape, title }` → `{ edit_url }` |
| POST | `/v1/canva/export` | `{ design_id, format: png|jpg|pdf|mp4 }` → `{ urls }` |
| POST | `/v1/post` | `{ text, targets[], page_id?, media?: { canva_design_id? , url?, kind, alt? }, tiktok?: { mode: draft|direct } }` |
| POST | `/v1/message` | `{ channel: gmail|outlook|x_dm, to, subject?, text, recipient_source? }` |
| POST | `/v1/polish` | `{ text, tone?, limit?, kind? }` |
| GET | `/v1/log` | — |

## Develop

`npm test` (19 tests, all network calls mocked) and `npm run typecheck`. `npx wrangler dev` runs it locally with a `.dev.vars` file for secrets (git-ignored).
