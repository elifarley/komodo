# Intent: Fix OIDC login losing the exchanged JWT — UI never authenticates (moghtech/komodo#1665)

Author: Elifarley. Status: draft — **superseded in mechanism by the design spec**:
[docs/superpowers/specs/2026-10-01-komodo-oidc-login-jwt-redeem-race-fix-1665-design.md](../specs/2026-10-01-komodo-oidc-login-jwt-redeem-race-fix-1665-design.md)
§7. The "one-shot invalidate on token-store change" and storage-listener machinery sketched in
Proposed outcome were deleted in roast round 1 (unreachable on the default success path; the
storage arm invalidated into a stale in-memory snapshot); the settlement-gate direction, the
constraints, and the repro-before-fix mandate stand.

## Problem

Behind a reverse proxy, Komodo v2.3.3 OIDC login completes at the protocol
level (portal auth, consent, callback `303 → /?redeem_ready=true`,
`ExchangeForJwt` → **200** with the JWT in the response body), yet the UI
never sends that JWT on any subsequent request: `GetCoreInfo`, `GET /user`,
`GetUserId` all 401 credential-less, and the login modal re-appears in a
loop ([moghtech/komodo#1665](https://github.com/moghtech/komodo/issues/1665)).

Server-side validation is exonerated: replaying the exact JWT with `curl`
returns 200 direct and through the proxy. The client receives a valid token
and does not send it back.

The token plumbing lives mostly in pinned npm dependencies
(`mogh_ui@1.2.7`, `mogh_auth_client@1.7.1`, source: moghtech/lib):

- redeem: `useAuthState` fires `ExchangeForJwt` once (module-level guard) →
  `LOGIN_TOKENS.add_and_change(jwt)` (localStorage `mogh-auth-tokens-v1`) →
  `sanitizeQueryInner` → full-page `location.replace` reload.
- requests: every komodo query hook gates `enabled: !!LOGIN_TOKENS.jwt()`,
  and `komodo_client()` attaches `authorization` only when the token is
  non-empty at client construction.

The wire evidence (valid JWT received; zero authenticated follow-ups) does
not yet match any single obvious line in the pinned code — a candidate
mechanism tree (silent `add_and_change` drop, reload race, stale-token
query fire, exchange-failure path leaving `jwt_redeem_ready` stuck) must be
resolved by reproduction before the fix is finalized.

Compounding, per the same issue: `auth_rate_limit` keys on the client IP as
seen by core, so behind a proxy one bad page load (4–5 credential-less 401s
in under a second) locks the shared proxy IP for all users. The limiter
keying lives in `mogh_auth_server` (moghtech/lib), outside this fix's repo
scope.

## Proposed outcome

A fix contained to moghtech/komodo's own code (no dependency bump):

1. **Reproduce first** — a local docker-compose harness (komodo core + mongo
   + mock OIDC provider + Caddy reverse proxy) reproduces the reported
   401 loop deterministically and pins which candidate mechanism loses the
   token.
2. **Settlement gate (approach A)** — komodo's router tracks redeem
   settlement explicitly: queries mount only once the token store is
   settled (token present, or redeem definitively failed → navigate to
   `/login` instead of mogh_ui 1.2.7's eternal spinner), and a one-shot
   "invalidate all queries" fires when the token store changes, so any
   query that mounted a moment too early refetches exactly once.
3. Bounded requests: no credential-less 401 storm → the per-IP rate limiter
   is no longer fed by the race (its behind-proxy keying itself is filed
   upstream, out of scope).

## Affected users and systems

- Any Komodo deployment using `oidc_enabled` login, especially behind a
  reverse proxy where the exchange-vs-queries race loses (issue reporter's
  Authelia 4.39 + Caddy 2.11.4 setup; komodo.example.com).
- Same-host deployments race the same way with a smaller losing window.
- Users behind a shared egress/proxy IP additionally suffer lockouts from
  the per-IP auth rate limiter once the loop feeds it.
- Upstream: changes target `ui/src` (router gate, query lifecycle) of
  moghtech/komodo; `mogh_ui`/`mogh_auth_client` stay pinned at 1.2.7/1.7.1.

## Constraints

- **Repo scope: komodo only.** moghtech/lib problems are worked around from
  komodo's code and/or reported upstream, not patched here.
- **No dependency bump** — `mogh_ui@1.2.7` / `mogh_auth_client@1.7.1` stay
  pinned; the fix must work against their current exported API.
- **No regressions:** local-credential login, passkey + TOTP second-factor
  paths, linked-login flows, and same-host OIDC (which works today) must
  keep working; the gate must not spin forever where login is genuinely
  absent (no-token page loads still land on `/login` promptly).
- Verification happens in the local docker harness (not the live i7
  deployment), asserting behavior (authenticated follow-ups on the wire),
  not just exit codes.
- Markdown gates first: intent and spec are committed before any quality
  gate runs.

## Open questions

1. Which candidate mechanism does the harness confirm (drives which branch
   of the settlement gate carries the fix)?
2. Does the one-shot invalidate-on-token-change need a `storage`-event
   listener, same-tab write detection, or both (mogh_ui writes
   same-tab before the full-page reload)?
3. Should the failed-redeem fallback (1.2.7 leaves `jwt_redeem_ready` true
   forever) navigate to `/login` immediately on exchange error, or after a
   short bounded retry window (an exchange can legitimately fail on a
   consumed session — retrying can't help per upstream's own analysis)?
4. Does the fix need a komodo-side `backto` preservation adjustment so the
   post-login landing returns to the pre-login URL after the new gate?
