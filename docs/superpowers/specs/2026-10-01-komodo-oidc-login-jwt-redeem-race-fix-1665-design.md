# Design: Fix OIDC login losing the exchanged JWT (moghtech/komodo#1665)

- Date: 2026-10-01
- Status: draft (pre-roast)
- Intent: [docs/superpowers/intents/2026-10-01-komodo-oidc-login-jwt-redeem-race-fix-1665-intent.md](../intents/2026-10-01-komodo-oidc-login-jwt-redeem-race-fix-1665-intent.md)
- Issue: [moghtech/komodo#1665](https://github.com/moghtech/komodo/issues/1665) · Related: moghtech/komodo#1506, moghtech/komodo#1375, moghtech/komodo#959
- Scope: moghtech/komodo only (`ui/src`, `compose/`, docs). Dependencies `mogh_ui@1.2.7` / `mogh_auth_client@1.7.1` stay pinned.
- Upstream sources read for this design (not modified): moghtech/lib `ui/src/auth/*` (mogh_ui), `auth/client/ts` (mogh_auth_client), `auth/server` (mogh_auth_server).

---

## 1. Problem (one paragraph)

OIDC login through a reverse proxy completes at the protocol level — callback returns
`303 → /?redeem_ready=true`, `POST /auth/login/ExchangeForJwt` returns **200** with the JWT in
the body — and then every subsequent UI request goes out **without an `authorization` header**
and 401s, looping back to the login modal. Curl replay of the same JWT returns 200 direct and
through the proxy: the client holds a valid token it never sends. Compounding: core's
`auth_rate_limit` keys on socket IP, so behind a proxy the 401 storm locks out all users of that
proxy IP (mitigated upstream-side only by `auth_rate_limit_disabled`).

## 2. Goals

1. After a successful OIDC redeem, the UI sends the exchanged JWT on every follow-up request —
   asserted on the wire, not inferred from UI state.
2. Every redeem failure path converges: no eternal `LoadingScreen`; the user lands on `/login`
   with a notification instead.
3. Bounded request count around the redeem window so the per-IP rate limiter is no longer fed
   by the race.
4. A reproducible harness (docker compose) that discriminates the candidate mechanisms and
   proves the fix, kept in-repo following the `compose/` convention.

## 3. Non-goals

- Fixing `mogh_ui` / `mogh_auth_client` / `mogh_auth_server` themselves (moghtech/lib) —
  file upstream issues instead; where noted below, upstream candidates are listed so the
  reports write themselves from harness evidence.
- Changing the per-IP rate-limiter keying (lives in `mogh_auth_server`; komodo only controls
  `auth_rate_limit_disabled` / `_max_attempts` / `_window_seconds` config).
- Dependency bumps, new runtime dependencies, or a frontend unit-test framework (komodo has
  none today; verification is harness-based).
- Passkey/TOTP/linked-login behavioral changes (only their non-regression is in scope).

## 4. Current behavior, code-anchored (v2.3.3 = main)

| Where | Behavior |
|---|---|
| `ui/src/main.tsx:27-29` | `QueryClient({ queries: { retry: false } })` — an errored query latches its error until invalidated/remounted; `refetchOnWindowFocus` stays at React Query default (true). |
| `ui/src/main.tsx:33-43` | `WebsocketProvider` wraps `<Router />` — it mounts on every page load, **outside** the router's redeem gate. `ui/src/lib/socket.tsx:63` calls `useRead("GetCoreInfo", {})` from inside it. |
| `ui/src/router.tsx:47-51` | `useAuthState().jwt_redeem_ready` (truthy when URL has `?redeem_ready=true`) → `LoadingScreen`. Non-reactive: read from `location.search` at render; the eventual `location.replace` reload is what clears it. |
| `ui/src/router.tsx:142-148` | `RequireAuth`: `!MoghAuth.LOGIN_TOKENS.jwt() || error` → navigate `/login?backto=…`. |
| `ui/src/lib/hooks.ts:41-46` | `komodo_client()` attaches `authorization` only when `LOGIN_TOKENS.jwt()` is non-empty at construction. Every `useRead`/`useUser` gates `enabled: !!LOGIN_TOKENS.jwt()` **evaluated at render**. |
| mogh_ui 1.2.7 `auth/index.js` | `useAuthState`: module-level `jwt_redeem_sent` guard; on `redeem_ready` fires `ExchangeForJwt` once. `onSuccess`: `LOGIN_TOKENS.add_and_change(jwt)` → `sanitizeQueryInner(search)` → **full-page `location.replace`** reload. `onError`: notification only — **no state change, no fallback**: `jwt_redeem_ready` stays true → eternal `LoadingScreen`. |
| mogh_auth_client 1.7.1 `tokens.ts` | `add_and_change` **silently drops** the token when `jwtDecode(jwt).sub` is falsy (`if (!user_id) return;`). |
| `bin/core` | Auth rate limiter: `GENERAL_RATE_LIMITER` etc. keyed by IP as seen by core (`with_failure_rate_limit_using_ip`); behind a proxy that is the proxy IP for everyone. |

## 5. Root-cause landscape (what the harness must discriminate)

The wire evidence ("valid JWT received; zero authenticated follow-ups, ever") is not yet
attributable to one line. Candidate mechanisms, each falsifiable in the harness:

| # | Mechanism | discriminating signal |
|---|---|---|
| M1 | **Stale-token query fire**: an expired JWT from a previous session sits in localStorage → all `enabled: !!jwt()` gates pass → queries fire (with the stale token) from `WebsocketProvider`/other mounts *during* the redeem gate's `LoadingScreen`; errors latch (`retry: false`); later refetches keep reusing whatever `jwt()` returns. | requests logged during redeem carry the *stale* token; localStorage write happens after them |
| M2 | **Silent token drop**: exchange succeeds but `add_and_change` early-returns (missing/odd `sub`) → localStorage never updated → reload lands on login modal; gated queries can only have fired via a stale token (M1 overlay) | localStorage `mogh-auth-tokens-v1` never gains the exchanged token |
| M3 | **Reload interception**: the post-exchange `location.replace` navigation is bounced by the proxy's forward-auth (session cookie consumed at that instant) → redirect back to portal → callback → new `redeem_ready` → loop. Matches "7 exchanges / 0 authed" + "reloading re-runs the same loop". | proxy access log shows the sanitize navigation hitting forward-auth and redirecting out |
| M4 | **Latched errors**: queries that fired early (with or without token) error once and are never re-run after the token lands (no invalidation on token-store change; focus refetch insufficient/absent) | requests *with* the fresh token absent even after token lands + focus events |
| M5 | **Exchange failure stalls**: any exchange error (consumed session, 429 from limiter) leaves the 1.2.7 eternal spinner — a different observable (no login modal), worth reproducing to bound the fix's fallback path | spinner forever after a forced exchange failure |

The fix (§7) is built to cover M1, M2 (komodo-side detection), M4, and M5 regardless of which
the harness confirms first; M3, if confirmed, additionally requires the §7.4 proxy-safe
navigation change. Upstream-filed leftovers: M2's silent drop, M3's forward-auth interplay,
and the rate-limiter keying.

## 6. Harness (Phase 1) — `compose/oidc-dev.compose.yaml` + `compose/oidc-dev/`

Follows the flat `<name>.compose.yaml` convention; support files under `compose/oidc-dev/`.

Services:

1. `mongo` — reuse `compose/mongo.compose.yaml` shape.
2. `komodo-core` — official `ghcr.io/moghtech/komodo-core` image, digest-pinned, config via
   env (`KOMODO_HOST`, `KOMODO_OIDC_ENABLED`, `KOMODO_OIDC_PROVIDER`, `KOMODO_OIDC_REDIRECT_HOST`,
   `KOMODO_LOCAL_AUTH`, docs: Advanced Setup). Registered callback:
   `https://komodo.oidctest.localhost/auth/oidc/callback`.
3. `komodo-ui` — built **from this branch** (`ui/Dockerfile`), so fix iterations are testable;
   served to core the same way production composes wire it.
4. `oidc-mock` — `node-oidc-provider` (small, configurable: authorization-code + PKCE +
   `client_secret_basic`), auto-approve consent, static test user. Source under
   `compose/oidc-dev/oidc-mock/` (no npm installs on the host; built in-image).
5. `caddy` — mirrors the reporter's shape: TLS via local CA for `komodo.oidctest.localhost`,
   `forward_auth` to the mock portal, `komodo.example.com`-equivalent host → core. **Access
   log as JSON including request headers** (assertion source for wire behavior).
6. `latency` knob — Caddy `delay` on the core upstream for `/auth/login/*` (and a second
   profile for static assets) to widen the race deterministically instead of relying on
   lucky timing.

Instrumentation & assertions (`compose/oidc-dev/verify.mjs`, run with the Playwright install
the repo's CI-free flow allows; headless chromium):

- Drive: portal login → consent → callback → `?redeem_ready=true` → exchange.
- Capture per-request: URL, `authorization` header present (yes/no), status, timestamp
  (from Caddy JSON access log + browser console shim that logs `LOGIN_TOKENS` state transitions).
- Assert the *failure* reproduces pre-fix (at least one of M1/M3/M4 observed), and post-fix:
  ≥1 authenticated (`authorization`-bearing) request within 3 s of exchange 200; total
  credential-less requests around the redeem window bounded (≤ 4 per 15 s — at the limiter's
  default 5/15 s a fifth attempt would trip it); final app state = dashboard rendered.
- Non-regression scripts: local login (valid + wrong password), direct `/` navigation with no
  token (must land on `/login?backto=…`, not spinner), same-host profile (no proxy) OIDC login.

Deliverable gate: the harness output names the confirmed mechanism(s) before §7 code lands.

## 7. The fix (Phase 2) — settlement gate (approach A)

All changes in `ui/src` plus, only if M3 confirms, the §7.4 navigation adjustment.

### 7.1 New module `ui/src/lib/redeem-gate.ts`

Owns the redeem lifecycle as *state komodo can render against*, using primitives it already
has (no mogh_ui internals):

- **MutationCache subscription**: mogh_ui's `useLogin("ExchangeForJwt")` runs on komodo's own
  `QueryClient`, so komodo observes the mutation's `pending → success/error` precisely —
  no polling, no wrapping of the npm singleton.
- Exposes: `redeemState: "idle" | "pending" | "settled-ok" | "settled-failed"`, plus
  `useRedeemSettled()` and a `notifyTokenChanged()` hook point.
- **Failed-redeem fallback (fixes M5)**: on `settled-failed`, call mogh_ui's exported
  `sanitizeQuery()` (strips `redeem_ready` etc. from the URL) and let `Router` fall through to
  the login page. One attempt only — upstream's own analysis stands: retrying a consumed
  session cannot help, and retrying would feed the limiter.

### 7.2 `ui/src/router.tsx`

- Gate becomes the *conjunction* of today's URL check and the settlement state:
  show `LoadingScreen` while `jwt_redeem_ready || redeemState === "pending"`;
  on `settled-failed` stop gating (URL already sanitized → login page renders);
  on `settled-ok` stop gating (mogh_ui's reload re-mounts everything fresh; if the reload is
  delayed/absent, §7.3 covers the window).
- `RequireAuth` unchanged: a settled-but-tokenless state still routes to `/login` exactly as
  today (no-token page loads must not spin — non-regression).

### 7.3 One-shot invalidate on token change (fixes M1/M4 fallout)

- In the same module: watch `LOGIN_TOKENS.jwt()` value transitions — same-tab detection via a
  cheap interval that lives **from the first non-idle redeem state until the first token
  change is observed or the gate disengages** (bounded lifetime; no steady-state polling)
  plus a `window.addEventListener("storage")` for cross-tab writes.
- On first transition empty→non-empty (or token-value change) **once per page load**:
  `queryClient.invalidateQueries()` (all) — a query that mounted a beat too early refetches
  exactly once, with the new token. No retry storm by construction.

### 7.4 Only if M3 confirms: proxy-safe settle navigation

Replace reliance on mogh_ui's `location.replace` full reload for the success path: on
`settled-ok`, komodo performs SPA navigation (`useNavigate()` to the `backto`-stripped path)
after `add_and_change` has visibly landed (token present), keeping the query cache and
removing the proxy round-trip that forward-auth can intercept. mogh_ui's own reload, when it
also fires, is harmless (idempotent remount). Guarded behind the M3 finding so we do not
duplicate lib behavior speculatively.

### 7.5 Socket-initiated queries during the gate (M1 surface)

`WebsocketProvider` mounts outside `Router`. If the harness shows M1 (stale-token queries
firing during redeem): defer the socket connection (and its `GetCoreInfo` read) until
`useRedeemSettled()` inside `socket.tsx` — the provider stays mounted (main.tsx untouched),
only its connect effect waits. If M1 does not reproduce, leave as-is (no speculative change).

## 8. Error handling matrix

| Case | Pre-fix | Post-fix |
|---|---|---|
| Exchange 200 | reload; works if token landed | reload (or §7.4 SPA nav); gate stays up until token visible; one-shot invalidate covers early mounts |
| Exchange network error / 429 / consumed session | eternal spinner | `sanitizeQuery()` + login page + notification (existing `useLogin` onError toast) |
| No token, direct `/` | login redirect | unchanged |
| Stale token in localStorage during redeem | stale-token 401s fire, errors latch | queries deferred behind settlement (§7.5 if confirmed) + one-shot invalidate |
| Tab focus after latched errors | refetchOnWindowFocus may or may not fire | invalidate already ran on token change; latched state impossible post-settlement |

## 9. Verification (Phase 3)

1. `compose/oidc-dev` harness green per §6 assertions (failure reproduced pre-fix; fix green).
2. Non-regression scripts: local login valid/invalid, no-token navigation, same-host OIDC.
   Passkey/TOTP are verified by non-touch only — no §7 change may modify their render or
   request paths (`git diff` scope check), since the harness cannot exercise WebAuthn
   hardware.
3. `yarn build` in `ui/` (tsc) clean; no new runtime deps in `ui/package.json`.
4. Manual smoke against the harness with `auth_rate_limit` at defaults: complete OIDC login,
   then deliberately trigger the old race window (latency profile) — zero 401 burst, no
   limiter lockout.
5. Each §8 row exercised by name in the harness output.

## 10. Risks / open items

- **MutationCache coupling**: relies on mogh_ui 1.2.7's `useLogin` using the ambient
  QueryClient (verified in dist: `useMutation` from `@tanstack/react-query`, ambient client).
  If upstream changes this, the gate degrades to the URL check (today's behavior) — no
  regression, only lost improvement.
- **PR hygiene**: `docs/superpowers/**` (this spec + intent) are workflow artifacts — they
  must not ride in the upstream PR. The cv-plan-pr step rebases code commits onto a clean
  branch (or drops the docs commits) before pushing.
- **Harness TLS**: `*.localhost` + Caddy local CA keeps everything self-contained; no external
  DNS or public CT-log noise.
- `node-oidc-provider` version pin recorded in the harness README so the mock's quirks
  (claim shapes) stay reproducible.

## 11. Success criteria

- [ ] Harness reproduces ≥1 candidate mechanism pre-fix with wire-level evidence.
- [ ] Post-fix: authenticated follow-ups on the wire within 3 s of exchange 200; UI lands on
      dashboard; credential-less request burst bounded; no rate-limiter lockout at defaults.
- [ ] All §8 rows behave as tabulated; passkey/TOTP code paths untouched (diff scope check).
- [ ] Diff confined to `ui/src`, `compose/oidc-dev*`, and (only if M3) §7.4; no dep changes.
- [ ] Upstream issue drafts (mogh_ui silent drop; limiter keying; forward-auth interplay if
      M3) exit criteria: each cites harness evidence.
