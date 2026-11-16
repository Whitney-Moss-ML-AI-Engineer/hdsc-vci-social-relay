# CLAUDE.md — hdsc-vci-social-relay
- Isolated project. hdsc-vci-web and hdsc-vci-mobile call it only over HTTPS `/v1/*` (see README API table). No shared code.
- Single owner: every route except the OAuth callback and /v1/media requires the RELAY_OWNER_TOKEN bearer.
- Never commit secrets. Provider tokens are AES-GCM sealed before KV writes.
- One press of Send = one post or one message. Never add scheduling, bulk sends, auto-replies or auto-follow-ups.
- LinkedIn: official Posts API only, for the founder's own profile or page. No LinkedIn messaging, scraping or browser automation of any site.
- Emails need a recorded address source and an opt-out line; never guess or construct email addresses. Keep daily caps.
- Run `npm test && npm run typecheck` before committing.
