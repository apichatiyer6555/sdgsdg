# Zaliv HTTP API (v1)

Single contract between `src/` (Fastify server) and `web/` (no-build SPA). All bodies are JSON (UTF-8).
Auth is a cookie session (`zaliv_sid`, HttpOnly, SameSite=Lax). Every non-GET request must send the header
`x-csrf-token: <csrf>` (value comes from `POST /api/auth/login` or `GET /api/auth/me`).

Errors: HTTP status + `{ "error": "<human readable, Russian>", "code": "<machine_code>" }`.
Common codes: `unauthorized` (401), `forbidden` (403), `csrf` (403), `not_found` (404), `validation` (400),
`conflict` (409), `rate_limited` (429), `must_change_password` (403, only `/api/auth/*` and `GET /api/system/ping` allowed).

Timestamps are ISO-8601 UTC strings or `null`. IDs of TikTok objects (advertiser, BC, campaign) are **strings**.
Our own ids (`account.id`, `user.id`) are integers.

## Types

```
Role = 'owner' | 'admin' | 'viewer'          // viewer: read only
User { id, login, role, mustChangePassword: boolean, disabled: boolean, createdAt, lastLoginAt }

AccountStatus =
  'new'              // no session yet
  'logging_in'       // login flow is running
  'need_code'        // TikTok asked for the e-mail code -> operator must call POST /code
  'need_manual'      // captcha / unknown step -> operator must use the remote browser
  'checking'         // session check running
  'active'           // session is valid
  'session_expired'  // cookies no longer valid
  'bad_credentials'  // wrong login/password
  'error'            // see statusDetail / lastError
  'disabled'         // switched off by the operator (skipped by auto sync)

Money { currency: string, amount: number }

Account {
  id, label, login, method: 'password' | 'session',
  status: AccountStatus, statusDetail: string,
  busy: null | 'login' | 'check' | 'sync' | 'assist',   // operation running right now
  waitingFor: null | 'code' | 'manual',                  // login flow is waiting for the operator
  hasPassword: boolean, hasSession: boolean, sessionUpdatedAt,
  proxy: string,            // masked ("http://user:***@host:8080"), '' when none
  tags: string[], client: string, notes: string,
  adAccountsCount: number, bcCount: number,
  spend7d: Money[],         // sum over this login's ad accounts
  lastLoginAt, lastCheckAt, lastSyncAt, lastError: string,
  createdAt, updatedAt
}

AdAccountState = 'delivering' | 'issue' | 'paused' | 'empty' | 'error' | 'unknown'

AdAccount {
  accountId: number, accountLabel: string,          // our login that owns the access
  id: string, name, country, currency, status: number | null,
  bcId: string, bcName: string,
  state: AdAccountState,
  campaigns: { total, loaded, working, enabled, problem },
  metrics: { spend, impressions, clicks, conversions, ctr: number|null, cpc: number|null, cpa: number|null },  // period "7d"
  reasons: [{ text, kind: 'balance'|'budget'|'rejected'|'review'|'schedule'|'off'|'other', count }],
  needsTopUp: boolean, error: string, syncedAt
}

Campaign {
  id, name, status: 'working' | 'issue' | 'off', enabled: boolean | null,
  reason: string, reasonKind: string,
  budget, spend, impressions, clicks, conversions,
  ctr, cpc, cpm, cpa, cvr                              // number | null
}

JournalEvent { id, ts, level: 'info'|'warn'|'error', kind: string, accountId: number|null, accountLabel: string, user: string, message: string }

BrowserInfo {
  active: boolean, kind: 'login' | 'assist' | null,
  width: number, height: number, url: string, title: string,
  state: string, message: string
}
```

## Auth

| Method & path | Body | Response |
|---|---|---|
| `POST /api/auth/login` | `{ login, password }` | `200 { user: User, csrf }` + cookie. `401 code=invalid_credentials`, `429` after 8 failures / 10 min per IP+login |
| `POST /api/auth/logout` | – | `204` |
| `GET /api/auth/me` | – | `200 { user: User, csrf }` or `401` |
| `POST /api/auth/change-password` | `{ currentPassword, newPassword }` (min 10 chars) | `204`; clears `mustChangePassword` |

## Dashboard

`GET /api/dashboard` →
```
{
  accounts:   { total, byStatus: { [AccountStatus]: number } },
  adAccounts: { total, delivering, issue, paused, empty, error },
  campaigns:  { total, working, problem },
  spend:      { '7d': Money[] },
  attention:  [{ kind: 'account' | 'adaccount', accountId, adAccountId: string|null, title, state, text }],   // max 50, worst first
  recentEvents: JournalEvent[],                    // last 15
  sync: { autoEnabled, intervalMin, running: number, queued: number, lastRunAt, nextRunAt }
}
```

## Accounts (TikTok logins)

| Method & path | Body / query | Response |
|---|---|---|
| `GET /api/accounts` | `?q=&status=&tag=&client=` | `{ items: Account[], tags: string[], clients: string[] }` |
| `POST /api/accounts` | `{ method: 'password'\|'session', label?, login?, password?, session?, proxy?, tags?: string[], client?, notes?, autoStart?: boolean }`. `password` method needs `login`+`password`; `session` method needs `session` (any cookie format, see below). `autoStart` runs login / session check right away | `201 Account` |
| `POST /api/accounts/import` | `{ text, tags?: string[], client?, proxy?, autoStart?: boolean }` — one account per line (see below) | `{ created: number, skipped: number, errors: [{ line: number, error: string }] }` |
| `GET /api/accounts/:id` | – | `{ account: Account, adAccounts: AdAccount[], events: JournalEvent[] }` |
| `PATCH /api/accounts/:id` | any of `label, login, password, proxy, tags, client, notes, disabled: boolean` (`proxy:''` clears; empty `password` is ignored) | `Account` |
| `DELETE /api/accounts/:id` | – | `204` (also removes ad accounts, events) |
| `POST /api/accounts/:id/session` | `{ session: string, check?: boolean }` replaces cookies | `Account` |
| `GET /api/accounts/:id/session/export` | – | `{ cookies: [...], origins: [...] }` (owner only, audited) |
| `POST /api/accounts/:id/login` | – | `202 Account` (needs saved password) |
| `POST /api/accounts/:id/code` | `{ code }` (4–10 chars) | `Account` — `409 code=not_waiting` when no flow waits for a code |
| `POST /api/accounts/:id/cancel` | – | `Account` — stops login flow / assist browser |
| `POST /api/accounts/:id/check` | – | `202 Account` — verify the saved session |
| `POST /api/accounts/:id/sync` | – | `202 Account` — refresh BCs, ad accounts, campaigns |
| `POST /api/accounts/bulk` | `{ ids: number[], action: 'login'\|'check'\|'sync'\|'delete'\|'tag'\|'set_client'\|'set_proxy'\|'disable'\|'enable', value?: string }` (`tag` adds a tag) | `{ ok: number[], failed: [{ id, error }] }` |

Session formats accepted by `session` (auto-detected): Chrome extension JSON arrays (EditThisCookie / Cookie-Editor / Cookie-Quick-Manager),
Playwright `storageState`, `{cookies:[...]}`, Netscape `cookies.txt`, raw `Cookie:` header / `name=value; name2=value2`.
Cookies without a domain are attached to `.tiktok.com`.

Import line formats: `login:password`, `login;password`, `login|password|proxy|tag1,tag2|client`, TAB separated. `#` starts a comment.

### Remote browser (login assist / manual work)

Available while a login flow is active (`busy='login'`) or an assist browser is open (`busy='assist'`).

| Method & path | Body | Response |
|---|---|---|
| `GET /api/accounts/:id/browser` | – | `BrowserInfo` |
| `GET /api/accounts/:id/browser/screenshot` | `?t=<cache buster>` | `image/jpeg`, `404` if no page |
| `POST /api/accounts/:id/browser/input` | `{ type: 'click'\|'dblclick'\|'type'\|'key'\|'scroll'\|'navigate', x?, y?, text?, key?, dy?, url? }`. `x`,`y` are viewport pixels (`BrowserInfo.width/height`); `key` is a Playwright key name (`Enter`, `Tab`, `Backspace`, `Control+A`); `navigate` only to `*.tiktok.com` | `204` |
| `POST /api/accounts/:id/browser/open` | `{ url? }` opens an assist browser with the saved session (default Ads Manager home) | `BrowserInfo` |
| `POST /api/accounts/:id/browser/close` | – | `204` (saves refreshed cookies when the session is valid) |

## Ad accounts (advertiser accounts found under all logins)

| Method & path | Body / query | Response |
|---|---|---|
| `GET /api/ad-accounts` | `?q=&state=&accountId=&bcId=&currency=` | `{ items: AdAccount[], period: { id: '7d', st, et }, totals: { spend: Money[] }, bcs: [{ id, name }], currencies: string[] }` |
| `GET /api/ad-accounts/:accountId/:advertiserId/campaigns` | – | `{ adAccount: AdAccount, items: Campaign[], period: { id, st, et }, syncedAt }` |

## Journal

`GET /api/journal?accountId=&level=&limit=100&before=<id>` → `{ items: JournalEvent[], hasMore: boolean }` (audit + login/sync events, newest first).

## Settings, users, system

| Method & path | Body | Response |
|---|---|---|
| `GET /api/settings` | – | `{ autoSyncEnabled, syncIntervalMin }` |
| `PUT /api/settings` | `{ autoSyncEnabled?: boolean, syncIntervalMin?: number }` (15–1440) (owner/admin) | same |
| `GET /api/users` | – | `{ items: User[] }` (owner only) |
| `POST /api/users` | `{ login, password, role }` (owner only) | `201 User` |
| `PATCH /api/users/:id` | `{ role?, password?, disabled? }` (owner only) | `User` |
| `DELETE /api/users/:id` | – | `204` (owner only, cannot delete self) |
| `GET /api/system` | – | `{ version, uptimeSec, node, tiktokOrigin, browser: { ready: boolean, headless: boolean, interactive: { active, max }, background: { active, max, queued } }, scheduler: { enabled, intervalMin, lastRunAt, nextRunAt, running }, counts: { accounts, adAccounts, campaigns } }` |
| `POST /api/system/sync-all` | – | `202 { queued: number }` — all `active` accounts |
| `GET /healthz` | no auth | `{ ok: true }` |

## Polling

The SPA polls `GET /api/accounts` every 2.5 s while any account has `busy` set or `waitingFor` set, otherwise every 20 s.
