# Design: Fix OIDC login losing the exchanged JWT (moghtech/komodo#1665)

- Date: 2026-10-01
- Status: draft — post-roast round 2 (round 1: `~/.claude/reports/code-roast/2026-10/01/1459.speckomodo1665jwtredeemrace.roast.md`, all 15 verified findings applied — a 16th candidate was refuted in the round-1 ledger. Round 2: `~/.claude/reports/code-roast/2026-10/01/1700.speckomodo1665jwtredeemracer2.roast.md`, all 14 findings applied — 1 critical, 4 major, 7 minor + 2 promoted; both rounds verified against the pinned artifacts)
- Intent: [docs/superpowers/intents/2026-10-01-komodo-oidc-login-jwt-redeem-race-fix-1665-intent.md](../intents/2026-10-01-komodo-oidc-login-jwt-redeem-race-fix-1665-intent.md) — the intent's proposed-outcome sketch (one-shot invalidate on token-store change) is superseded by this spec's §7 posture; its problem statement and constraints stand.
- Issue: [moghtech/komodo#1665](https://github.com/moghtech/komodo/issues/1665) · Related: moghtech/komodo#1506, moghtech/komodo#1375, moghtech/komodo#959
- Scope: moghtech/komodo only (`ui/src`, `compose/`, docs). Dependencies `mogh_ui@1.2.7` / `mogh_auth_client@1.7.1` stay pinned.
- Upstream sources read for this design (not modified): moghtech/lib `ui/src/auth/*` (mogh_ui), `auth/client/ts` (mogh_auth_client), `auth/server` (mogh_auth_server); `@tanstack/query-core@5.102.4` `build/modern/mutation.cjs` (pinned per `ui/yarn.lock`).

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
2. Every redeem outcome converges — success, definite failure, or unknown (hung request): no
   eternal `LoadingScreen` on any path; a definite failure lands on `/login` **with a visible
   notification in the same document**.
3. Bounded request count around the redeem window **and zero residual credential-less feed
   after settlement-failure**, so the per-IP rate limiter is not fed by the race nor held open
   by a stale token.
4. A reproducible harness (docker compose) that discriminates the candidate mechanisms and
   proves the fix, kept in-repo following the `compose/` convention.

## 3. Non-goals

- Fixing `mogh_ui` / `mogh_auth_client` / `mogh_auth_server` themselves (moghtech/lib) —
  file upstream issues instead; where noted below, upstream candidates are listed so the
  reports write themselves from harness evidence.
- Suppressing mogh_ui 1.2.7's post-success full-page reload. Verified control flow
  (`query-core@5.102.4` `mutation.cjs`): mogh_ui's mutation `onSuccess` (token write +
  `sanitizeQueryInner` → `location.replace`) runs **before** the `success` dispatch that any
  MutationCache subscriber observes — no komodo-side hook exists between the token write and
  the navigation. The design therefore **embraces the reload** (§7 posture) rather than
  fighting it; suppressing it requires an upstream mogh_ui change (§7.4).
- Changing the per-IP rate-limiter keying (lives in `mogh_auth_server`; komodo only controls
  `auth_rate_limit_disabled` / `_max_attempts` / `_window_seconds` config).
- Dependency bumps, new runtime dependencies, or a frontend unit-test framework (komodo has
  none today; verification is harness-based).
- Passkey/TOTP/linked-login behavioral changes (only their non-regression is in scope).

## 4. Current behavior, code-anchored (v2.3.3 = main)

| Where | Behavior |
|---|---|
| `ui/src/main.tsx:27-29` | `new QueryClient({ defaultOptions: { queries: { retry: false } } })` — an errored query latches its error until invalidated/remounted; `refetchOnWindowFocus` stays at React Query default (true). Komodo constructs the `QueryClient` (and therefore can construct its `MutationCache`) here. |
| `ui/src/main.tsx:33-43` | `WebsocketProvider` wraps `<Router />` — it mounts on every page load, **outside** the router's redeem gate. `ui/src/lib/socket.tsx:58` mounts `useUser()` and `:63` `useRead("GetCoreInfo", {})` from inside it. |
| `ui/src/router.tsx:47-51` | `useAuthState().jwt_redeem_ready` (truthy when URL has `?redeem_ready=true`) → `LoadingScreen`. Non-reactive: read from `location.search` at render; the eventual `location.replace` reload is what clears it. mogh_ui fires `redeemJwt({})` **inside `useAuthState`'s body during Router's render** (mogh_ui dist `auth/index.js:102-105`). |
| `ui/src/router.tsx:142-148` | `RequireAuth`: `!MoghAuth.LOGIN_TOKENS.jwt() || error` → navigate `/login?backto=…`. |
| `ui/src/lib/hooks.ts:41-46` | `komodo_client()` attaches `authorization` only when `LOGIN_TOKENS.jwt()` is non-empty at construction. Every `useRead`/`useUser` **call site mounted outside the app tree** gates `enabled: !!LOGIN_TOKENS.jwt()` **evaluated at render** — but `useRead` spreads `...config` **after** computing `enabled` (`hooks.ts:99-104`), so callers passing an explicit `enabled` override the jwt gate wholesale (9+ such call sites repo-wide; none mounted during the redeem window — latent, see §7.6). `useUser` also polls (`hooks.ts:57`, `refetchInterval: 30_000`) and refetches on focus. |
| mogh_ui 1.2.7 `auth/index.js` | `useAuthState`: module-level `jwt_redeem_sent` guard; on `redeem_ready` fires `ExchangeForJwt` once. `onSuccess`: `LOGIN_TOKENS.add_and_change(jwt)` → `sanitizeQueryInner(search)` → **full-page `location.replace`** reload. `onError`: in-memory Mantine notification only — **no state change, no fallback**: `jwt_redeem_ready` stays true → eternal `LoadingScreen`. |
| mogh_ui 1.2.7 `auth/utils.js` | `sanitizeQuery`/`sanitizeQueryInner` strip `redeem_ready`/`totp`/`passkey` then `location.replace(...)` — **cross-document navigation**, not a URL tidy-up. |
| mogh_auth_client 1.7.1 `tokens.js` | `LOGIN_TOKENS` is a module-load IIFE: one `localStorage.getItem` at import, `jwt()` reads memory only, **no storage-event re-sync**. `add_and_change` **silently drops** the token when `jwtDecode(jwt).sub` is falsy (`if (!user_id) return;`). `remove_all` exists. |
| `@tanstack/query-core@5.102.4` `mutation.cjs` + `notifyManager.cjs` | Execute ordering: cache-config `onMutate` (synchronous, **every** execute) → conditional `#dispatch({type:"pending"})` (only when an `options.onMutate` changed context — for mogh_ui's `onMutate`-less mutation it may never fire) → `retryer.start()` → cache-config `onSuccess` → **mutation `options.onSuccess`** (mogh_ui's write+reload) → `onSettled` ×2 → **then** `#dispatch({type:"success"})`; the catch path dispatches `{type:"error"}` after `options.onError`. Every dispatch notifies via `notifyManager.batch` → **`systemSetTimeoutZero`** — a macrotask — so a render-phase-fired mutation's notifications can land before React's passive effects commit any effect-scoped subscriber. Cache listeners receive `{type:"updated", action, mutation}`; a `MutationCache` **config** hook (`new MutationCache({ onMutate, onSuccess })` — komodo owns this object in `main.tsx`) runs synchronously inside `execute`, before mogh_ui's handlers. |
| `bin/core` | Auth rate limiter: `GENERAL_RATE_LIMITER` etc. keyed by IP as seen by core (`with_failure_rate_limit_using_ip`: `api/listener/router.rs:242`, `api/ws/mod.rs:78` — note the **ws route is limiter-covered too**); behind a proxy that is the proxy IP for everyone. `oidc_auto_redirect` (default false, `config/core.config.toml:294`, wired `bin/core/src/auth/mod.rs:365`) can itself produce a redirect loop — see M6. |

## 5. Root-cause landscape (what the harness must discriminate)

The wire evidence ("valid JWT received; zero authenticated follow-ups, ever") is not yet
attributable to one line. Candidate mechanisms, each falsifiable in the harness:

| # | Mechanism | discriminating signal |
|---|---|---|
| M1 | **Stale-token query fire**: an expired JWT from a previous session sits in localStorage → all `enabled: !!jwt()` gates pass → queries fire (with the stale token) from the always-mounted `WebsocketProvider`/`useUser` poll *during* the redeem gate's `LoadingScreen`; errors latch (`retry: false`) | requests logged during redeem carry the *stale* token; localStorage write happens after them |
| M2 | **Silent token drop**: exchange succeeds but `add_and_change` early-returns (missing/odd `sub`) → localStorage never updated → reload lands on login modal; gated queries fire only via a stale token (M1 overlay) | localStorage `mogh-auth-tokens-v1` never gains the exchanged token, while the exchange 200'd |
| M3 | **Reload interception**: the post-exchange `location.replace` navigation is bounced by the proxy's forward-auth (session cookie consumed at that instant) → redirect back to portal → callback → new `redeem_ready` → loop. Matches "7 exchanges / 0 authed" + "reloading re-runs the same loop" | proxy access log shows the sanitize navigation hitting forward-auth and redirecting out |
| M4 | **Latched errors**: queries that fired early error once and are never re-run after the token lands | with the fix's posture (§7) this is covered by the remount (the success path reloads unconditionally); the harness verifies no residual latched state post-reload |
| M5 | **Exchange failure stalls**: any exchange error (consumed session, 429 from limiter) leaves the 1.2.7 eternal spinner | spinner forever after a forced exchange failure |
| M6 | **Core-side auto-redirect loop**: `oidc_auto_redirect = true` misconfiguration produces its own redirect loop, indistinguishable from M3 in a proxy log | loop persists with the proxy's forward_auth removed, or the env knob set true; harness pins it false (§6) |

The fix (§7) covers M1 (conditional §7.5), M2 (detection + surfaced flag, §7.3), M4 (via the
remount), and M5 (watchdog + failure fallback) regardless of which the harness confirms first.
**M3 has no komodo-side fix under the pinned dependency** (§7.4 states the contingency) — the
harness still discriminates M3 vs M6 so the upstream report carries evidence either way.
Upstream-filed leftovers: M2's silent drop, M3's forward-auth interplay, the rate-limiter
keying, and mogh_ui's missing storage re-sync.

## 6. Harness (Phase 1) — `compose/oidc-dev.compose.yaml` + `compose/oidc-dev/`

Follows the flat `<name>.compose.yaml` convention; support files under `compose/oidc-dev/`.

Services:

1. `mongo` — reuse `compose/mongo.compose.yaml` shape.
2. `komodo-core` — official `ghcr.io/moghtech/komodo-core` image, digest-pinned, config via
   env (`KOMODO_HOST`, `KOMODO_OIDC_ENABLED`, `KOMODO_OIDC_PROVIDER`, `KOMODO_OIDC_REDIRECT_HOST`,
   `KOMODO_LOCAL_AUTH`, **`KOMODO_OIDC_AUTO_REDIRECT=false` pinned explicitly** — a core-side
   auto-redirect loop would be misattributed to M3; docs: Advanced Setup). Registered callback:
   `https://komodo.oidctest.localhost/auth/oidc/callback`.
3. `komodo-core` runs the **branch-built UI via a core-override image** — there is no
   standalone `komodo-ui` service: `ui/Dockerfile`'s final stage is `FROM scratch` (dist at
   `/ui`) and cannot run as a service, while production serves the dist from `/app/ui`
   **inside** the core image (`bin/core/aio.Dockerfile`, served by mogh_server's
   `serve_static_ui` fallback, `bin/core/src/api/mod.rs:7,41`). The harness therefore builds
   `compose/oidc-dev/core-ui.Dockerfile`: stage 1 reuses `ui/Dockerfile`'s builder stage
   verbatim on this branch; stage 2 `FROM` the **same digest-pinned komodo-core image** +
   `COPY --from=builder /builder/ui/dist /app/ui` — the "served by core exactly like
   production" property, with the branch's fix under test.
4. `oidc-mock` — `node-oidc-provider` (small, configurable: authorization-code + PKCE +
   `client_secret_basic`), auto-approve consent, static test user. Source under
   `compose/oidc-dev/oidc-mock/` (no npm installs on the host; built in-image).
5. `caddy` — mirrors the reporter's shape: TLS via local CA for `komodo.oidctest.localhost`,
   `forward_auth` to the mock portal, host → core. **Access log as JSON including request
   headers** (assertion source for wire behavior).
6. `latency` knob — Caddy `delay` on the core upstream for `/auth/login/*` (and a second
   profile for static assets) to widen the race deterministically instead of relying on
   lucky timing.

Instrumentation & assertions (`compose/oidc-dev/verify.mjs`, headless chromium):

- Drive: portal login → consent → callback → `?redeem_ready=true` → exchange.
- Capture per-request: URL, `authorization` header present (yes/no), status, timestamp
  (from Caddy JSON access log + browser console shim that logs `LOGIN_TOKENS` state transitions).
- **Request bound, defined precisely**: the window is `[callback 303 → dashboard rendered]`,
  where **dashboard rendered** = the dashboard route (`/`) mounted AND `useUser`'s `["GetUser"]`
  query resolved successfully — the same condition `RequireAuth` needs to paint real content
  (a concrete DOM marker in `ui/src/pages/dashboard/` may replace this at implementation if
  one is cheaper to assert). Count **app-originated requests that are unauthenticated OR
  receive 401/403** — the quantity the per-IP limiter actually consumes is *failed attempts*,
  and a stale-token request carries a (doomed) `authorization` header, so a header-less-only
  count cannot see the M1 storm this bound exists to prevent. Assert a window **total** ≤ 4
  **and** a sliding-window **max ≤ 4 per any 15 s** (the limiter's default window; a fifth
  failed attempt trips it — `config/core.config.toml:346-351`). Keep the header-less count as
  a secondary metric.
- Assert the *failure* reproduces pre-fix (at least one of M1/M3/M4/M5/M6 observed), and
  post-fix: ≥1 authenticated (`authorization`-bearing) app request within 3 s of exchange 200;
  final app state = dashboard rendered (definition above).
- **Zero-residual assertion**: in the settled-failure scenario, zero unauthenticated-or-401/403
  app-originated requests **and zero failed websocket handshake attempts** (the ws route is
  limiter-covered, `api/ws/mod.rs:78`) in the 60 s after settlement-failure (stale-token
  cleanup, §7.2).
- **Gate-isolation assertion** (C-009): a failed non-redeem mutation (e.g. a failing
  `useWrite` action) does not flip the gate — no LoadingScreen flip, no reload to `/login`.
- Non-regression scripts: local login (valid + wrong password), direct `/` navigation with no
  token (must land on `/login?backto=…`, not spinner), same-host profile (no proxy) OIDC
  login, and passkey login via a Playwright CDP **virtual authenticator** (passkey success
  shares mogh_ui's write+reload `onSuccess` but never engages the redeem gate — O-008).

Deliverable gate: the harness output names the confirmed mechanism(s) before §7 code lands.

## 7. The fix (Phase 2) — settlement gate, "embrace the reload" posture

Posture: mogh_ui 1.2.7's success path reloads the document unconditionally, and no komodo-side
hook can precede that navigation (§4, §3). So the reload **is** the recovery mechanism — a
remount refetches everything — and komodo's job shrinks to three things: bound the pending
state, route definite failures gracefully in-document, and make silent drops observable.
The reload-targeting machinery a previous draft carried (one-shot invalidate on token change,
cross-tab storage arm, SPA navigation) is **deleted**: the invalidate was unreachable on the
default success path (token write and reload initiation share one task, so the watch interval
always resolved via gate-disengage, never via observation), and the storage arm invalidated
into `LOGIN_TOKENS`' stale in-memory snapshot (no re-sync in the pinned lib).

### 7.1 New module `ui/src/lib/redeem-gate.ts`

Owns the redeem lifecycle as *state komodo can render against* — with **deterministic arming**,
because mogh_ui fires the redeem mutation during Router's render and query-core delivers cache
notifications as `setTimeout(0)` macrotasks: an effect-scoped subscriber can miss the mutation's
start entirely (and the `pending` action dispatch is conditional anyway — for mogh_ui's
`onMutate`-less mutation it may never fire). The design therefore never depends on observing a
`pending` event:

- **Module-scope `MutationCache` config (the arming + recording path)**: komodo constructs
  `new MutationCache({ onMutate, onSuccess })` in `main.tsx` and passes it to the `QueryClient`
  it already owns. Config hooks run synchronously inside `execute` — before the fetch, before
  mogh_ui's handlers, before any scheduler — so arming cannot lose a race with React:
  - `onMutate(variables, mutation)`: if `mutation.options.mutationKey?.[0] === "ExchangeForJwt"`
    (mogh_ui's `useLogin` sets that key) → `redeemState = "pending"` + arm the watchdog.
  - `onSuccess(data, variables, context, mutation)`: same filter; persist the exchange `data`
    to `sessionStorage` (M2/M3 evidence, §7.3/§7.4) — this hook runs **before** mogh_ui's
    handler, i.e. before the token write and the reload initiation.
- **Filtered MutationCache subscription (the settlement path)**: `redeem-gate.ts` also
  subscribes via `queryClient.getMutationCache().subscribe(listener)`, matching only
  `{type:"updated"}` events whose `mutation.options.mutationKey?.[0] === "ExchangeForJwt"` and
  whose `action.type` is `"success"` or `"error"`. Settlements happen at least one network
  round-trip after render, so the subscriber provably exists by then. Every other mutation
  (`useWrite`, `useExecute`, …) is ignored — an unfiltered listener would flip the whole app
  to LoadingScreen or reload to `/login` on any unrelated action mutation (harness assertion,
  §6).
- **States**: `"idle" | "pending" | "settled-ok" | "settled-failed"`.
- **Watchdog (bounds `pending`)**: armed by `onMutate`, a 12 s timer; on fire,
  `redeemState = "settled-failed"` with reason `"timeout"`. Browser `fetch` has no default
  timeout — a black-holing proxy would otherwise hang the gate forever. A **late success after
  the watchdog fired is tolerated, not suppressed**: mogh_ui's own `onSuccess` still stores the
  token and reloads, and its login page auto-redirects through `backto ?? "/"` when a valid
  token appears (mogh_ui dist `auth/login/index.js:40,49-55`) — recovery lands on the
  pre-login URL. Komodo never re-triggers the mutation, so there is no consumed-session
  double-redeem.
- **Cleanup contract (StrictMode-safe)**: the subscription + watchdog timer live behind
  explicit teardown (`unsubscribe`, `clearTimeout`) called from the module's one effect;
  double-invoke leaves no leaked listener or timer past gate disengage.
- No polling, no storage listeners, no `notifyTokenChanged` surface — none has a consumer.

### 7.2 `ui/src/router.tsx`

- The gate reads **settlement state only** — never the URL bit. `LoadingScreen` while
  `redeemState === "pending"`; gate down on `settled-ok` (mogh_ui's reload remounts
  everything) and on `settled-failed` (below). mogh_ui's own `jwt_redeem_ready` return value
  stays unused by the gate: after a `location.replace` is initiated the current document's
  `location.search` still shows `?redeem_ready=true` until the new document commits, so a URL
  keyed conjunction would keep the gate up through the failure path.
- **Settled-failed path (in-document, no reload)**:
  1. `LOGIN_TOKENS.remove_all()` — clears the stale/exchange-era token so the always-mounted
     `useUser` poller stops feeding credential-less 401s into the per-IP limiter
     (zero-residual assertion, §6).
  2. Strip `redeem_ready`/`totp`/`passkey` via `history.replaceState` (same-document; mirrors
     `sanitizeQueryInner`'s param handling without the navigation).
  3. Show a Mantine notification (in-document — it survives because there is no reload),
     then drop the gate: `RequireAuth` sees no token → routes to `/login?backto=…` using the
     existing flow (no new backto handling; intent open question 4 resolved as "no change").
- mogh_ui's own `onError` toast also fires (it runs inside `options.onError`, before the
  dispatch komodo's listener sees — so **two notifications appear**: mogh_ui's red
  console-pointer toast, upstream-owned and not suppressible without an upstream change, plus
  komodo's §7.2 notification naming the outcome and where the user landed).

### 7.3 Silent-drop detection (M2, komodo-side)

In the §7.1 subscription — which fires **after** mogh_ui's `onSuccess` has run — on
`settled-ok`, determine whether the exchanged token landed, **decode-free**: read
`localStorage["mogh-auth-tokens-v1"]` directly and check whether any `tokens[].jwt` entry
equals the exchanged jwt string (schema `{current, tokens: [{user_id, jwt}]}`, pinned from
mogh_auth_client 1.7.1 `tokens.js`; string-compare avoids any JWT decoder — `ui/package.json`
declares no `jwt-decode`, and importing the transitive package would be undeclared coupling;
`MoghAuth.extractUserIdFromJwt` is the fallback if a `sub`-keyed check is ever needed). The
whole read is wrapped in `try/catch`: a corrupt stored value must **not** throw inside the
cache notify cycle — on parse failure log the raw value to console, mark detection
unavailable, and skip (degradation, not crash). If the exchange carried a jwt but no matching
entry landed, set `sessionStorage["komodo-redeem-drop"]` — guarded by a feature check: when
`sessionStorage` is unavailable (storage blocked / quota), degrade to a console-only signal
and note it in the §8 row. The flag (when writable) survives the reload; the fresh page's
login page reads it, surfaces "Login succeeded but the session could not be stored on this
device", logs the raw evidence to console, and clears the flag. This is detection +
user-visible delta + upstream-issue evidence — the drop itself is upstream-owned
(`add_and_change`'s silent early-return).

### 7.4 M3 contingency — stated, not built

If the harness confirms M3 (forward-auth bouncing the post-exchange navigation), **there is no
komodo-side fix under the pinned dependency**: the reload is initiated inside mogh_ui's
`onSuccess` before any komodo hook runs, and `BrowserRouter` is unmounted while the gate is up
(no router context to navigate in, even if a hook existed). The contingency, in order:
(a) upstream mogh_ui change — suppress the reload or make `onSuccess` composable — is the
real fix; (b) this PR scopes itself to the remaining mechanisms and the upstream report
carries the harness evidence. Instrumentation komodo *can* add now (already part of §7.1's
config object): the filtered `onSuccess` hook receives the exchange `data` **before**
mogh_ui's handler and persists it to `sessionStorage` — pre-navigation evidence of "exchange
200'd, navigation departed" that makes the M3 loop measurable for the upstream report. This
hook records; it does not redirect, retry, or otherwise act.

### 7.5 Socket-initiated queries during the gate (M1 surface)

`WebsocketProvider` mounts outside `Router` and mounts **three** things
(`ui/src/lib/socket.tsx`): `useUser()` at `:58` (30 s poll + focus refetch), the
`GetCoreInfo` read at `:63`, and the connect effect at `:75-102`. If the harness shows M1
(stale-token queries firing during redeem), defer **all three** until `useRedeemSettled()`
inside `socket.tsx` — gate the `useUser()`/`useRead` calls via their `enabled` config (or a
settled-guard early-return in the hook), not just the connect effect, or the `GetUser` poll
keeps feeding stale-token 401s through the whole redeem window. The provider stays mounted
(main.tsx untouched). If M1 does not reproduce, leave as-is (no speculative change).

### 7.6 Drive-by: `useRead`'s config spread defeats the jwt gate

`hooks.ts:99-104` computes `enabled: hasJwt && config?.enabled !== false` and then spreads
`...config` after it, so any caller passing an explicit `enabled` replaces the jwt gate
wholesale (9+ call sites repo-wide; none mounted during the redeem window today — latent).
One-line fix: spread `...config` first, then compute `enabled`, so the gate composes with
caller intent instead of being overridden by it. In scope because this fix's whole subject is
credential-less request prevention; flagged in the PR as a drive-by so reviewers see it.

## 8. Error handling matrix

| Case | Pre-fix | Post-fix |
|---|---|---|
| Exchange 200, token stored | reload; works if token landed | unchanged reload path; remount refetches everything (no latched redeem-window state survives); M2 check silent no-op |
| Exchange 200, token dropped (M2) | silent: reload → login modal, no signal | detected in-document pre-reload; flag surfaced on the login page after the reload ("session could not be stored") + console evidence; if `sessionStorage` is unavailable, console-only signal (degraded, stated) |
| Exchange error (network / 429 / consumed session) | eternal spinner; toast dies with no navigation (URL stays `redeem_ready=true`) | in-document convergence: token store cleared, params stripped (`history.replaceState`), visible notification, gate drops → `/login`; no document reload, toast survives |
| Hung exchange (no response) | eternal spinner | watchdog (12 s) flips to the same settled-failed path; a late 200 still recovers via mogh_ui's own handler (store + reload); komodo never re-triggers |
| No token, direct `/` | login redirect | unchanged |
| Stale token in localStorage during redeem (M1) | stale-token 401s fire from always-mounted provider; errors latch | **all three provider-body reads deferred** (§7.5, if M1 confirms: `useUser` poll, `GetCoreInfo`, connect effect); post-settlement residual feed eliminated by §7.2's `remove_all` |
| Latched errors after settlement | latched until remount/invalidation | latched redeem-window errors are remounted away by the success reload; post-settlement errors still latch (pre-existing behavior, unchanged scope) |
| Any non-redeem mutation in flight/failing | unaffected | still unaffected — the gate's subscription is filtered to `ExchangeForJwt` (§7.1) |

## 9. Verification (Phase 3)

1. `compose/oidc-dev` harness green per §6 assertions (failure reproduced pre-fix; fix green;
   zero-residual and gate-isolation assertions included).
2. Non-regression scripts: local login valid/invalid, no-token navigation, same-host OIDC,
   passkey via virtual authenticator.
3. `yarn build` in `ui/` (tsc) clean; no new runtime deps in `ui/package.json`.
4. Manual smoke against the harness with `auth_rate_limit` at defaults: complete OIDC login,
   then deliberately trigger the old race window (latency profile) — zero 401 burst, no
   limiter lockout.
5. Each §8 row exercised by name in the harness output.

## 10. Risks / open items

- **MutationCache coupling**: the gate relies on mogh_ui 1.2.7's `useLogin` running on the
  ambient QueryClient and setting `mutationKey: ["ExchangeForJwt"]` (both verified in the
  pinned dist). If upstream changes either, the subscription goes silent and the gate
  degrades to today's URL-check behavior — a lost improvement, not a regression.
- **Residual stale-token feed**: fully eliminated only on the settled-failed path
  (§7.2 `remove_all`). A stale token surviving a *successful* redeem (superseded but valid
  entry for another user id) is multi-account behavior outside this issue's scope; noted for
  the upstream rate-limiter report.
- **M3 outcome**: if confirmed, this PR ships without a fix for the loop itself (§7.4) —
  called out in the PR body so reviewers don't mistake scope for oversight.
- **PR hygiene**: `docs/superpowers/**` (this spec + intent) are workflow artifacts — they
  must not ride in the upstream PR. The cv-plan-pr step rebases code commits onto a clean
  branch (or drops the docs commits) before pushing.
- **Harness TLS**: `*.localhost` + Caddy local CA keeps everything self-contained; no external
  DNS or public CT-log noise.
- `node-oidc-provider` version pin recorded in the harness README so the mock's quirks
  (claim shapes) stay reproducible.

## 11. Success criteria

- [ ] Harness reproduces ≥1 candidate mechanism pre-fix with wire-level evidence; M3 vs M6
      discrimination included (`KOMODO_OIDC_AUTO_REDIRECT=false` pinned).
- [ ] Post-fix: authenticated app-originated follow-ups on the wire within 3 s of exchange
      200; UI lands on dashboard (§6 definition); redeem-window unauthenticated-or-401/403
      bound met (window total ≤ 4, sliding 15 s max ≤ 4); zero unauthenticated-or-401/403 app
      requests and zero failed ws handshakes in the 60 s after a settled-failure; no
      rate-limiter lockout at defaults.
- [ ] Watchdog arming is deterministic (module-scope `MutationCache` config `onMutate`, not an
      effect-raced subscription): a hung-exchange harness row converges via settled-failed in
      every run, not probabilistically.
- [ ] All §8 rows behave as tabulated, including the M2 surfaced flag, the watchdog
      convergence, and the gate-isolation row; passkey/TOTP code paths untouched (diff scope
      check); passkey non-regression exercised via virtual authenticator.
- [ ] Diff confined to `ui/src` and `compose/oidc-dev*`; no dep changes.
- [ ] Upstream issue drafts (mogh_ui silent drop + missing storage re-sync; limiter keying;
      forward-auth interplay / reload suppression if M3) exit criteria: each cites harness
      evidence.

## 12. Intent open questions — resolutions

1. *Which candidate mechanism does the harness confirm?* — Still open by design; §7 covers
   M1/M2/M4/M5 unconditionally-in-posture, conditionally-in-mechanism (§7.5), and M3 as a
   stated contingency (§7.4).
2. *Storage-event listener, same-tab detection, or both?* — Neither: deleted in roast round 1
   (the storage arm invalidated into a stale in-memory snapshot; the same-tab interval was
   unreachable). The remount supersedes both.
3. *Failed-redeem fallback: immediate or bounded retry?* — Immediate, one attempt, no retry
   (a consumed session cannot be redeemed again; retries refuel the limiter) — now via the
   in-document §7.2 path, plus the §7.1 watchdog for the unknown-outcome class.
4. *`backto` preservation through the new gate?* — No change needed: the settled-failed path
   drops into the existing `RequireAuth` → `/login?backto=…` flow untouched.
