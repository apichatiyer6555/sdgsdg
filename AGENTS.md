# Zaliv — notes for agents working in this repo

Central admin for many TikTok Ads logins (Fastify + SQLite + Playwright/Chromium + no-build SPA). Production: https://zaliv.vibecods.xyz,
folder `D:\server-projects\zaliv.vibecods.xyz` on the Windows/Docker host, container `zaliv-app`, Caddy block in `D:\server-projects\reverse-proxy\Caddyfile`.

## Run / test

- `npm install` · `npm start` (needs `APP_KEY`, see `.env.example`; outside production a random key is generated per start).
- `npm test` — unit + API + browser flows against `test/helpers/mock-tiktok.js` + UI e2e (`test/ui-e2e.test.js`). Needs Chrome/Chromium
  (`BROWSER_EXECUTABLE`, or Playwright's bundled one). `SHOTS_DIR=/tmp/shots npm test` also saves UI screenshots.
- In production the same suite runs inside the container: `docker exec zaliv-app npm test` (`ZALIV_TEST_CHANNEL=1` exercises the production launch path).
- UI-only development without the backend: `node web/dev/mock-server.js 4010` (fixtures for 300 logins) and `node web/dev/ui-test.mjs`.

## Map

- `docs/API.md` — the contract between `src/` and `web/`; change both sides together.
- `src/browser/` — `pool.js` (Chromium, slots), `login-flow.js` (login state machine), `operations.js` (login / check / sync / assist),
  `interactive.js` (remote browser), `page-scripts.js` (code executed inside the TikTok page — must stay self-contained).
- `src/lib/tiktok-model.js` — campaign normalization/status rules (ported from the TTAds Hub extension).
- `docs/TIKTOK-NOTES.md` — what is known about TikTok's login page and internal API, and what is NOT verified live.

## Rules

- Never log or return TikTok passwords/cookies; they are encrypted with `APP_KEY` (`src/lib/crypto.js`). DTOs expose only `hasPassword` / `hasSession`.
- All browser work goes through `Operations`; one operation per account (`busy`), interactive slots are limited (`BROWSER_MAX_INTERACTIVE`).
- User-Agent must not contain `HeadlessChrome` (TikTok pages never finish loading) — see `BrowserPool.userAgent`.
- `docs/reference/` (private extension research) is git-ignored on purpose; do not commit it: the repository is public.
- Deploy: `deploy/update.ps1` (git pull + `docker compose up -d --build`); Caddy block: `deploy/caddy-zaliv.conf` / `deploy/add-caddy-block.ps1`.
