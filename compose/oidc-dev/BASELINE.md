# Pre-fix baseline — mechanisms reproduced (Task 5, PHASE-1 GATE)

- **Date:** 2026-10-02 (batch runs 00:10:04–00:16:16, host local time -03:00;
  `exchange-error` re-run at 00:30:25 — provenance note in its section)
- **Suite commit / HEAD:** `fa53da3c0` — `compose/oidc-dev/verify.mjs` exactly as
  committed there (no local edits); branch `komodo-oidc-login-jwt-redeem-race-fix-1665`
- **UI under test:** **stock v2.3.3** — last commit touching `ui/` is the `v2.3.3`
  tag commit itself (`780ac68b9`); the branch carries no §7 code yet (Phase 2 not
  started). Core image = digest-pinned `ghcr.io/moghtech/komodo-core@sha256:bca73d0e…`
  (tag `2.3.3`).
- **Harness origin:** podman shim (`DOCKER_HOST=unix:///run/user/1000/podman/podman.sock`
  + standalone `docker-compose`); all browser-facing origins carry `:8443`
  (rootless podman cannot publish privileged ports — README §Deviations 1). Mongo 8,
  core (branch UI build), oidc-mock (`oidc-provider@9.12.2`), Caddy 2.11, delay sidecar.
- **Method:** all 7 scenarios re-run **fresh** for this baseline (Task 4's cached
  `out/*.ndjson` moved aside before the first run — none of the excerpts below is a
  cached read). Individual runs, ≥16 s apart (per-IP auth limiter 5 attempts/15 s;
  `all` mode's spacing, applied manually). Every scenario printed
  `SCENARIO <name> PASS` with exit 0; FIX-DEPENDENT checks report `SKIP` pre-fix by
  design (never PASSed without `--post-fix`).
- **Evidence files:** `out/<scenario>.ndjson` (gitignored). Excerpts below quote the
  evidentiary rows with two uniform elisions, both cut to `…` — the `out/` files carry
  the full values: (1) oversized jwt strings are truncated mid-value; (2) fields with
  no evidentiary weight in that excerpt (`host`, uncited `ts`/`ts_ms`, `duration_s`)
  are dropped from the middle of a row. Never elided: `url`, `status`, `auth`, and any
  timestamp the surrounding text cites.

**Gate verdict: ≥1 mechanism reproduced (M1, M2, M5) → PROCEED to Phase 2 (Tasks 6–10).**

> **Task 11 post-fix results:** the second half of this document (same harness,
> `--post-fix` enforced, branch UI) is the "Post-fix run (Task 11)" section at
> the bottom — including one **real post-fix FAIL** (`m1-seeded`) with
> root-cause analysis, and the upstream issue drafts.

| Scenario | Result | Mechanism signal |
|---|---|---|
| `success` | PASS (7/7) | environment row — no mechanism, regression guard |
| `latency` | PASS (8/8) | environment row with the knob — round-trip 2027 ms ≥ 2000 ms |
| `m1-seeded` | PASS (4/4) | **M1 REPRODUCED** — stale-token reads fire during pending |
| `m2-forced` | PASS (4/4 +1 SKIP) | **M2 REPRODUCED** — silent `add_and_change` drop |
| `exchange-error` | PASS (3/3 +2 SKIP) | **M5 REPRODUCED** — 401 → eternal spinner |
| `hung` | PASS (3/3 +3 SKIP) | slow success, NOT an eternal spinner (see §hung) |
| `isolation` | PASS (3/3) | regression guard — gate already isolated pre-fix |

---

## success (environment row)

Stock happy path is healthy: the exchange 200 lands, the very next app request is
authenticated, the ws connects, and the dashboard renders. The window-bound guards
(§6) observe **zero** unauth/401/403/auth-5xx rows — nothing else in the login
cascade is burning the limiter.

```
{"kind":"req","ts":1790910608.6233966,…,"method":"POST","url":"/auth/login/ExchangeForJwt","auth":false,"status":200,"duration_s":0.015468786}
{"kind":"req","ts":1790910608.7805629,…,"method":"GET","url":"/user","auth":true,"status":200,"duration_s":0.001466645}   ← 157 ms after the 200
{"kind":"req","ts":1790910616.7822032,…,"method":"GET","url":"/ws/update","auth":false,"status":101,"duration_s":7.367679162}
checks: window total 0 · sliding-15s max 0 · dashboard rendered at /
```

## latency (environment row + knob)

Identical shape with `DELAY_AUTH_MS=2000`; the point is that the delay sidecar is
really in the path and only on `/auth/login/*`:

```
{"kind":"req","ts":1790910652.511251,…,"method":"POST","url":"/auth/login/ExchangeForJwt","auth":false,"status":200,"duration_s":2.026986392}
check: observed exchange round-trip >= DELAY_AUTH_MS (2000ms; observed 2027ms) PASS
```

## m1-seeded — **M1 REPRODUCED**

Seed: a structurally-valid, bad-signature jwt (`current:"stale-user"`, tail
`hwIjoxfQ.stale-signature`) in `mogh-auth-tokens-v1` before the drive;
`DELAY_AUTH_MS=1500` widens the redeem window. The stale-token requests fire from
the always-mounted provider subtree **before** the exchange settles:

```
{"kind":"fetch","ts_ms":1790910697471,"path":"/user","auth_tail":"hwIjoxfQ.stale-signature"}
{"kind":"fetch","ts_ms":1790910697472,"path":"/read/GetCoreInfo","auth_tail":"hwIjoxfQ.stale-signature"}
{"kind":"req","ts":1790910697.4745677,"method":"GET","url":"/user","auth":true,"status":500,"duration_s":0.001200671}
{"kind":"req","ts":1790910697.4746535,"method":"POST","url":"/read/GetCoreInfo","auth":true,"status":500,"duration_s":0.000997077}
{"kind":"req","ts":1790910699.008,…,"method":"POST","url":"/auth/login/ExchangeForJwt","auth":true,"status":200}   ← window closes 1.53 s LATER
```

Wire rows prove auth-header **presence** + rejection + timing (Caddy redacts the
value); the fetch-shim rows prove the **value** — those two requests carried the
seeded stale token, not the fresh one. The same shim shows the stale token is also
attached to the `ExchangeForJwt` call itself (ts 1790910697477), corroborated on the
wire by that row's own `auth:true` — mogh_ui attaches
whichever jwt is current to *all* API calls, which is why §6's residual unit counts
auth-bearing 5xx, not just 401/403. After settlement the pointer moves off the seed:

```
{"kind":"tokens","ts_ms":1790910696769,"detail":"TOKENS 1790910696767 {\"current\":\"stale-user\",…}"}
{"kind":"tokens","ts_ms":1790910699010,"detail":"TOKENS 1790910699009 {\"current\":\"6abf067c65cacd7846f1e424\",\"tokens\":[{…stale…},{\"user_id\":\"6abf067c…\",\"jwt\":\"…\"}]}"}
```

**Rejection code is 500, not 401.** Core answers the bad-signature jwt with 500 on
`/user` and `/read/GetCoreInfo` on this build. The spec's original "the server 401s
it" assumption (§6/§8) was already amended to "rejections (observed 500s)"; the
suite's predicate deliberately accepts 401/403/5xx and prints the observed statuses
so the discriminating signal stays *stale-token-authenticated request inside the
window*, not the exact code.

### M1 vs §7.5's design premise — CONFIRMED

§7.5 defers the always-mounted provider-subtree reads (`useUser` poll, `GetCoreInfo`,
connect effect) behind `enabled: gateOpen && hasJwt` for exactly this surface. The
observation matches the premise precisely: **stale-token reads fire during the
pending window** (`[drive start → exchange 200]`), from `WebsocketProvider`'s
mounted queries, with errors that would latch (`retry: false`). Nothing in the fresh
evidence contradicts §7.5; the deferral targets what actually happens.

## m2-forced — **M2 REPRODUCED**

Route interception rewrites the real 200's `body.jwt` to a structurally-valid
sub-less jwt. Upstream is 200; the client never stores it; the reload lands on
`/login` with **no signal**:

```
{"kind":"req","ts":1790910746.422467,…,"method":"POST","url":"/auth/login/ExchangeForJwt","auth":false,"status":200,"duration_s":0.026053597}
{"kind":"tokens","ts_ms":1790910739430,"detail":"TOKENS 1790910739429 null"}
{"kind":"tokens","ts_ms":1790910740042,"detail":"TOKENS 1790910740041 null"}        ← … every TOKENS row stays null
{"kind":"req","ts":1790910746.5997264,…,"method":"GET","url":"/assets/login-DoZQWzrW.js","auth":false,"status":200}   ← post-exchange reload loads the LOGIN chunk
{"kind":"req","ts":1790910746.64838,…,"method":"POST","url":"/auth/login/GetLoginOptions","auth":false,"status":200}
checks: sub-less jwt never lands in the token store PASS · reload lands on /login PASS
```

Every TOKENS row captured reads `null` and a grep for the sub-less jwt's payload
across the whole ndjson returns 0 hits — `add_and_change`'s early return dropped it
silently. The only user-visible consequence is the login page; the post-fix
"drop flag surfaced on the login page" check is the `SKIP`ped fix-dependent arm.

## exchange-error — **M5 REPRODUCED**

> Provenance: `out/` is a rolling cache — any later run of the suite overwrites a
> scenario's ndjson. The original batch run of this row (00:12–00:14) was overwritten
> by an out-of-band re-run, so this section was **re-run by this task** (same committed
> suite, same PASS verdict, stdout captured) and cites that run below. All other
> sections cite the batch runs whose files are still on disk.

Leg 1 completes a full login (dashboard). Replaying `/?redeem_ready=true` re-fires
the exchange against the ONE-SHOT pending state → 401 (this also burns one of the
5-per-15s limiter attempts; a UI loop that re-fires exhausts the budget and then
429s — the closest analogue to the reporter's "7 exchanges / 0 authed"):

```
{"kind":"req","ts":1790911828.2776556,…,"method":"POST","url":"/auth/login/ExchangeForJwt","auth":false,"status":200}   ← leg 1
{"kind":"req","ts":1790911833.434673,…,"method":"GET","url":"/?redeem_ready=true","auth":false,"status":200}             ← replay navigation
{"kind":"fetch","ts_ms":1790911833470,"path":"/auth/login/ExchangeForJwt","auth_tail":"k1pJsydNq3BaMmVjUKVrhvYg"}        ← still-stored jwt attached
{"kind":"req","ts":1790911833.4868107,…,"method":"POST","url":"/auth/login/ExchangeForJwt","auth":true,"status":401,"duration_s":0.016108626}
{"kind":"loader","ts_ms":1790911833544,"state":"on","detail":"LOADER 1790911833544 on"}                                  ← last loader row, ever
```

After the 401: **no navigation for the 8 s observation** (URL still
`/?redeem_ready=true`), the LoadingScreen's last observed state is `on` (eternal
spinner), and no second document load occurs. The 60 s residual window observed 0
unauth/401/403/auth-5xx rows and 0 failed ws handshakes — pre-fix this window is an
observation only (enforced under `--post-fix`); it confirms nothing *else* re-fires
the exchange while the spinner spins.

## hung — slow success, NOT an eternal spinner

`DELAY_AUTH_MS=15000` (past §7.1's 12 s watchdog). Pre-fix there is **no watchdog**,
so the LoadingScreen simply holds for the entire delay and the late 200 then
converges normally — the §8 row-4 pre-fix cell's "eternal spinner" is **refuted for
finite delays**; the eternal arm is only reachable by an exchange that never
settles, which a finite delay sidecar cannot produce (that arm belongs to the
post-fix watchdog run). The README's §8-row→scenario map already carries the
corrected pre-fix cell ("round-trip ≥ 15000 ms; LoadingScreen up with no OBSERVED
gap until the late 200 … slow-success reload documented") — BASELINE does not
restate it.

```
{"kind":"loader","ts_ms":1790910870627,"state":"on"}                                   ← redeem landing
{"kind":"req","ts":1790910885.644007,…,"method":"POST","url":"/auth/login/ExchangeForJwt","auth":false,"status":200,"duration_s":15.036977271}
{"kind":"tokens","ts_ms":1790910885647,"detail":"TOKENS 1790910885646 {\"current\":\"6abf067c…\",\"tokens\":[…]}"}   ← stored 3 ms after the 200
{"kind":"loader","ts_ms":1790910885832,"state":"on"}                                   ← still on, post-200, pre-reload (no gap)
{"kind":"loader","ts_ms":1790910886195,"state":"off"}                                  ← sanitize reload unmounts the spinner
checks: round-trip 15037 ms ≥ 15000 PASS · loader on with no OBSERVED gap (15017 ms; gap-off=false) PASS
pre-fix observation: after the late 200 the URL is / (slow-success reload)
```

Loader-on observed span: 886194 − 870626 = **15568 ms** — one continuous spinner
across the whole 15 s delay, ending only via the success reload. Caveat carried from
the suite: the shim polls at 100 ms, so sub-100 ms transitions could hide ("no
OBSERVED gap").

## isolation (regression guard)

A failing **non-redeem** execute (`POST /execute/StartDeployment` → 500) fired with
the stored jwt does not flip the gate, reload, or raise the LoadingScreen — stock
v2.3.3 already isolates mutations from the redeem path. Pre-fix PASS is expected
(README §Deviations 6); the row exists to catch an unfiltered §7.1 MutationCache
subscription in Phase 2.

```
check: probe failing execute returned non-auth 4xx/5xx (observed 500) PASS
check: no full-page reload to /login within 2s (URL /; marker alive) PASS
check: no LoadingScreen flip within 2s (flip observed: false) PASS
```

---

## Mechanism attribution (spec §5)

| # | Mechanism | Verdict | Evidence |
|---|---|---|---|
| M1 | Stale-token query fire | **REPRODUCED** | `m1-seeded`: stale-value `/user` + `/read/GetCoreInfo` (fetch-shim tail `…stale-signature`) hit core during pending, rejected 500, 1.53 s before the exchange 200 |
| M2 | Silent `add_and_change` drop | **REPRODUCED** | `m2-forced`: upstream 200, zero TOKENS transitions (all `null`), sub-less jwt absent from the store, reload → login chunk + `GetLoginOptions`, no signal |
| M3 | Forward-auth bounce → reload loop | **NOT REPRODUCED** (mock limitation — see below) | `success`/`exchange-error`: the post-exchange and post-replay reloads return 200 straight through the gate; zero `/verify` 503/401 bounces in any ndjson |
| M4 | Latched errors never re-run | **NOT INDEPENDENTLY REPRODUCED** | No dedicated §8 row by design; per §5 it is covered by the success-path remount, and `success`'s post-reload authed reads + dashboard + ws assert the recovered state (no residual latched state observed) |
| M5 | Exchange failure → eternal spinner | **REPRODUCED** | `exchange-error`: replayed exchange 401 → no navigation, last loader state `on` indefinitely |
| M6 | Core auto-redirect loop | **OUT BY CONSTRUCTION** | `core-config.toml` pins `oidc_auto_redirect = false`; per §6 the harness cannot produce it, and no loop signature appeared |

### M3 non-reproduction — what it does and does not mean

The mock's portal session **survives token redemption**, so the forward-auth gate
never bounces the post-exchange sanitize reload: every reload of
`/?redeem_ready=true` returns 200 and no scenario shows a `/verify` 401/503 storm or
a portal↔komodo loop. This is a **mock limitation, not an exoneration**: the
reporter's production gateway (Authelia-class) may consume/invalidate its session at
the redemption instant, which is exactly the M3 trigger this mock cannot express.
M3 therefore stays **live for the upstream report** (spec §7.4 records the
contingency: no komodo-side fix under the pinned dependency), and any loop observed
in a later run must be re-checked against core logs (`invalid peer certificate` /
discovery 500s are the known non-M3 confounders — README's debugging note) before
being attributed.

## Phase-1 gate decision

**PROCEED.** Three of the six candidate mechanisms reproduce with wire-level
evidence (M1, M2, M5), matching the spec's premise that the fix must cover all
three regardless of which reproduces first (§5). The environment rows (`success`,
`latency`, `isolation`) are green pre-fix, so Phase 2's post-fix runs have a clean
regression baseline, and `hung`'s pre-fix reality is documented for the §8 row-4
comparison.

---

*Metadata: produced by Task 5 (fresh runs, 2026-10-02 00:10–00:16 -03:00;
`exchange-error` re-run 00:30 -03:00); harness
per README "Run" (podman shim, `compose/oidc-dev.compose.yaml`, digest-pinned core
`sha256:bca73d0e…`, `oidc-provider@9.12.2`); suite at HEAD `fa53da3c0`; raw ndjson
evidence in gitignored `compose/oidc-dev/out/`.*

---

# Post-fix run (Task 11) — `--post-fix` arms enforced

Completes the second half of this document: same harness, same drive, same suite
— core rebuilt to serve the branch fix, every run carrying `--post-fix` so the
fix-dependent assertions were ENFORCED (never SKIPped) and the pre-fix mechanism
assertions SKIPped by design (`reportChecks`).

- **Date:** 2026-10-02 (runs 02:14:55–02:25:29 -03:00; individual runs, ≥16 s
  apart — the per-IP limiter discipline)
- **Suite:** `verify.mjs` byte-identical to `fa53da3c0` (no local edits; only the
  CLI flag differs from the Task 5 batch)
- **UI under test:** the branch fix (`49802408e…9d9a38a88`, spec §7.1–§7.7).
  Core image rebuilt for this run (`localhost/komodo-oidc-dev-core` id
  `5190032c1dbe`, built from HEAD `9d9a38a88`); before the runs the served
  bundles were grepped in-container for fix markers (`komodo-redeem` in
  `index-*.js`, the §7.3 drop toast in `login-*.js`), and the served
  `index-CfUQi4Ph.js` hash matches the host `cd ui && yarn build` output — the
  image provably serves this branch's build.
- **Host build acceptance:** `cd ui && yarn build` clean (exit 0).
- **Evidence:** all seven `out/<scenario>.ndjson` files refreshed by this batch
  (gitignored); excerpts below follow the same elision discipline as the pre-fix
  sections.

## Verdicts (pre-fix → post-fix)

| Scenario | Pre-fix (Task 5) | Post-fix (this run) | Fix-dependent arms (`--post-fix`) |
|---|---|---|---|
| `success` | PASS 7/7 | **PASS 7/7** | n/a — regression guard holds: window total 0, sliding 0, ws 101 + on_login, dashboard `/` |
| `latency` | PASS 8/8 | **PASS 8/8** | n/a — regression guard holds: round-trip 2030 ms ≥ 2000 ms |
| `m1-seeded` | PASS 4/4 (M1 REPRODUCED) | **FAIL 2/4** | **§7.5 zero-stale-reads arm FAILS** — 2 stale-token reads escape pre-arm (deep-dive below); fresh-pointer arm PASSES |
| `m2-forced` | PASS 4/4 +1 SKIP (M2 REPRODUCED) | **PASS 5/5** | drop flag surfaced in-document on the login page — M2 no longer silent |
| `exchange-error` | PASS 3/3 +2 SKIP (M5 REPRODUCED) | **PASS 3/3** (2 pre-fix arms SKIP) | converged failure in-document (exactly 1 document load, final `/login`) + zero-residual 60 s (0 bad rows, 0 failed ws) |
| `hung` | PASS 3/3 +3 SKIP (slow success) | **PASS 5/5** (1 pre-fix arm SKIP) | watchdog dropped the gate 12.0 s after landing — 3013 ms BEFORE the late 200; zero-residual 60 s (0/0); §7.7 recovered the late success → landed `/` |
| `isolation` | PASS 3/3 | **PASS 3/3** | n/a — §7.1's filtered subscription introduced no gate flip (regression guard holds) |

**6/7 green; `m1-seeded` red on its fix-dependent arm — a real result, analyzed
below (not a harness artifact and not papered over).**

## m2-forced — the silent drop now surfaces (M2 closed at the komodo layer)

Pre-fix: upstream 200 with a sub-less jwt → `add_and_change` early-returns on
falsy `sub` (`mogh_auth_client/dist/tokens.js`: `if (!user_id) return;`), zero
TOKENS transitions, reload lands on `/login` with **no signal**.

Post-fix run: the same drive (route interception rewrites `body.jwt` to the
sub-less token; upstream still 200), and the fix-dependent arm PASSED:

```
PASS exchanged (sub-less) jwt never lands in the token store (silent drop)      (pre-fix arm, still true)
PASS silent drop path: reload lands on /login (observed /login)                 (pre-fix arm, still true)
PASS post-fix: drop flag surfaced in-document on the login page                 (§7.3/§7.7 arm — NEW)
```

The drop is detected by the settlement listener (`initRedeemGate`: success
dispatch carried `jwt`, storage does not contain it → `writeFlag("drop")`) and
surfaced by `login.tsx` as the red toast "Login succeeded but the session could
not be stored". The probe finds the signal in-document at T+8 s because the
toast persists (`autoClose: false` — HEAD commit `9d9a38a88`; the Mantine 4 s
default raced exactly this probe). The library-level drop itself is upstream's
— draft issue (a) below.

## exchange-error — converged failure in-document (M5 closed at the komodo layer)

Pre-fix: replayed `/?redeem_ready=true` → 401 → no navigation for 8 s, last
loader state `on` indefinitely (eternal spinner), URL keeping `redeem_ready=true`.

Post-fix run — the two pre-fix arms SKIPped as designed, both fix-dependent arms
PASSED:

```
PASS replayed exchange 401 observed (one-shot consumed session; ts=1790918528.219)
SKIP (pre-fix mechanism assertion; not applicable with --post-fix) pre-fix: no navigation for 8s …
SKIP (pre-fix mechanism assertion; not applicable with --post-fix) pre-fix: eternal LoadingScreen …
PASS post-fix: in-document convergence to /login (final /login; document loads for the replay: 1)
PASS zero-residual 60s window (unauth-or-401/403-or-auth-5xx app rows: 0; failed ws handshakes: 0)
```

The settled-failed path (§7.2) converged the SAME document to `/login` — the
replay produced **exactly one** document load (no sanitize reload, no
retry-navigation), the URL/params were stripped via `history.replaceState`, and
the "Login didn't complete" notification carried the signal. Over the
observation's full 60 s window: zero unauth/401/403/auth-5xx rows and zero
failed ws handshakes — nothing re-fires the exchange, so the limiter budget is
no longer burning (pre-fix, a user-stuck spinner plus any reload loop would
exhaust the 5-per-15 s budget into 429s; draft issue (d) below).

## hung — watchdog converges, then the late success recovers (§7.1 + §7.7 closed)

`DELAY_AUTH_MS=15000`, past the 12 s watchdog. Pre-fix reality (Task 5): no
watchdog, one continuous spinner for 15.6 s, then the late 200 converged
normally (slow success).

Post-fix run — the pre-fix arm SKIPped; all three fix-dependent arms PASSED:

```
LOADER 1790918625455 on     ← redeem landing
LOADER 1790918637453 off    ← watchdog (12.0 s after landing) dropped the gate — 3013 ms BEFORE the late 200
req    1790918640466  POST /auth/login/ExchangeForJwt 200 (duration 15.030 s)
TOKENS 1790918640642 {"current":"6abf067c…"}   ← the LATE 200 still stored its token
LOADER 1790918640745 on / 1790918641045 off    ← §7.7 redirect transit
final URL: /  (§7.7 late-success redirect: login page found the fresh flag + jwt and sent the user to /)
PASS post-fix: watchdog dropped the gate BEFORE the late 200 (loader-off observed pre-settlement)
PASS post-fix: zero-residual 60s window after the watchdog settlement (0; failed ws: 0)
PASS post-fix: watchdog converges (gate drops -> /login with §7.7 late-success redirect)
```

This is the full §7.1→§7.7 sequence working end-to-end: watchdog fired at
~T+12.0 s (landing 625455 → off 637453 = 11998 ms), the gate settled-failed, the
user landed on `/login` instead of spinning, and when the exchange finally
returned 200 three seconds later, mogh_ui's own handler re-stored the token and
the one-shot §7.7 redirect (fresh `ok` flag + jwt present in the store →
`location.replace(backto ?? "/")`) recovered the login. Zero residual over the
60 s window.

## m1-seeded — §7.5 read deferral: **FAIL** (real post-fix defect)

Verbatim from the run (exit 1):

```
PASS exchange 200 observed (pending window closed; ts=1790918209.054)
FAIL stale-token requests fire during the redeem window (wire: auth+rejected in [drive start -> exchange 200]; observed 2, statuses 500)
FAIL stale token VALUE confirmed on those requests (fetch shim tail …hwIjoxfQ.stale-signature)
PASS fresh token stored after the exchange (current pointer moved off stale-user)
```

Under `--post-fix` the first two predicates invert (demand ZERO stale rows / NO
stale-tail fetch). The ndjson timeline:

```
DOC    1790918207418  GET /?redeem_ready=true 200            ← redeem document loads
FETCH  1790918207516  /user               tail …stale-signature
FETCH  1790918207517  /read/GetCoreInfo   tail …stale-signature
REQ    1790918207520  GET  /user              500 (auth)         ← both rejected 500
REQ    1790918207520  POST /read/GetCoreInfo  500 (auth)
FETCH  1790918207522  /auth/login/ExchangeForJwt  tail …stale-signature   ← the redeem dispatch
LOADER 1790918207541  on                                          ← LoadingScreen engages AFTER the reads
200    1790918209054  ExchangeForJwt (1500 ms knob)
TOKENS 1790918209056  {"current":"6abf067c…"}                     ← fresh pointer (PASS)
```

### What the fix did and did not change (both verified from this one ndjson)

- **During actual pending — [exchange dispatch → 200] — the deferral IS in
  force:** zero fetches to `/user|/read` in that span (and no ws attempt). §7.5's
  mechanism works from the flip onward.
- **But the two stale reads escape BEFORE the flip**, with the same shape as the
  pre-fix batch (there: reads at `…697471/472` vs dispatch `…477`): first-commit
  reads that the gate cannot reach. Wire-level M1 evidence is therefore
  **unchanged by the fix** in this scenario — same two reads, same 500s, same
  ~6 ms pre-dispatch timing.

### Root cause — wiring, not timing luck

1. mogh_ui arms the redeem synchronously in **Router's** render body
   (`useAuthState`: `if (jwt_redeem_ready && !jwt_redeem_sent) { redeemJwt({}); … }`).
2. The gated reads live in **WebsocketProvider — Router's parent** (`main.tsx`:
   `QueryClientProvider > WebsocketProvider > ThemeProvider > Router`).
   React renders parent-first, so the provider renders BEFORE the arm exists,
   with the gate still `idle` (open by design). Its `useUser`/`GetCoreInfo`
   observers commit with `enabled: true` and their mount fetches fire at
   +98 ms — ~6 ms before the exchange dispatch (+104 ms) flips the gate; the
   LoadingScreen row lands +119 ms (100 ms shim poll).
3. The `router.tsx` comment ("onMutate … flips the gate to `pending` before the
   snapshot read below, so render #1 is already the LoadingScreen") is true for
   Router's own output, but no render-phase flip inside a child can cover an
   ANCESTOR's same-commit observers. Task 9's deferral is structurally
   one render-phase step behind the arm.
4. Consequently the §8-map arm as specified ("zero such rows" in
   [drive start → exchange 200]) is unreachable with this wiring, while Task 9's
   own narrower verify wording ("no stale-token requests **during pending**") IS
   satisfied. Note this also corrects the Task 5 premise reading above: the
   stale reads never fired "during pending" — they fire in the same commit as
   the arm, pre-dispatch; the check window ([drive start → exchange 200]) simply
   includes that pre-arm gap.

Minimal candidate remedy (for a follow-up task — NOT attempted here, fix code is
Tasks 6–10 scope): pre-arm the gate at module scope in `main.tsx` before the
first render when `location.search` carries `redeem_ready=true` (mirroring
mogh_ui's own module-level `jwt_redeem_sent` guard), with the watchdog armed
from the same point and the existing settlement listener remaining the sole
source of `settled-*`. That closes the same-commit hole without touching the
tree shape.

---

## Upstream issue drafts (harness evidence attached; NOT filed)

DRAFT text for each upstream report. File paths verified against the pinned
dependency builds in `ui/node_modules` (`mogh_ui`, `mogh_auth_client` — the
versions stock v2.3.3 resolves).

### (a) mogh_ui / mogh_auth_client — `add_and_change` silently drops tokens whose `sub` is falsy

**Title:** `LOGIN_TOKENS.add_and_change silently discards a valid exchange response when the JWT has no `sub` claim`

**Body skeleton:**

- `mogh_auth_client/dist/tokens.js` (`add_and_change`):

  ```js
  const add_and_change = (jwt) => {
      const user_id = extractUserIdFromJwt(jwt); // jwtDecode(jwt).sub
      if (!user_id)
          return;                                 // silent: no throw, no log, no signal
  ```

- Failure shape (harness `m2-forced`, moghtech/komodo#1665 repro): the exchange
  returns upstream **200** with a structurally-valid jwt lacking `sub`;
  `add_and_change` drops it; the caller's `onSuccess` then treats login as
  complete and triggers the sanitize reload — the user lands on `/login` with
  **zero indication** anything failed (pre-fix evidence: every TOKENS row stays
  `null`, the jwt's payload never appears in storage, reload fetches the login
  chunk + `GetLoginOptions`).
- Expected: the drop is impossible to diagnose for the user and for support
  (looks like "login redirected me back and nothing happened").
- Suggested direction: throw/log on the falsy-`sub` early return (or surface a
  drop flag the host app can read). komodo's fix now detects + surfaces this
  client-side (`komodo-redeem` phase `drop` + a persistent toast), but the
  library behavior remains a silent swallow for any other embedder.

### (b) mogh_auth_client — `LOGIN_TOKENS` has no storage-event re-sync

**Title:** `LOGIN_TOKENS state is a module-init localStorage snapshot — no `storage` event listener, so multi-tab/multi-document state diverges`

**Body skeleton:**

- `mogh_auth_client/dist/tokens.js`: the IIFE reads `localStorage.getItem(...)`
  **once at module init** into a closure variable; every read (`jwt()`,
  `accounts()`) serves that closure; the only writer is the module's own
  mutators via `update_local_storage()`. No `window.addEventListener("storage",
  …)` anywhere in the module.
- Consequences: a second tab's login/logout/change never re-syncs this tab's
  closure (and vice versa); a long-lived document can keep sending a jwt that
  storage no longer contains (or miss one that was just stored).
- Harness evidence (adjacent, single-context suite): the redeem race fix had to
  re-read storage from `localStorage` directly to detect the (a) drop — the
  module's closure was not a trustworthy reflection of storage mid-login
  (`redeem-gate.ts` cites `tokens.js:5` for the key); and each new document
  re-reads the store at init (the suite's seed-once-per-context deviation:
  an unguarded re-seed re-poisoned every post-reload document — the per-document
  re-snapshot is observable), while a NOT-reloaded document never re-reads.
  Multi-tab divergence itself is outside this suite's reach (one browser
  context per drive) — flagged as code-verified, harness-adjacent.
- Suggested direction: subscribe to `storage` for `mogh-auth-tokens-v1` and
  re-hydrate the closure (or read through to storage per call).

### (c) mogh_ui — redeem failure has no in-document convergence (eternal spinner) + `sanitizeQuery` = full-page-reload control flow

**Title:** `Failed ExchangeForJwt leaves `redeem_ready=true` in the URL and the app on a LoadingScreen forever; success path uses a full-page reload as control flow`

**Body skeleton:**

- `mogh_ui/dist/auth/index.js` (`useAuthState`): the redeem mutation is armed
  from `search.get("redeem_ready") === "true"` with only an `onSuccess`
  (`useLogin`'s built-in `onError` shows a toast and logs — nothing else). On
  failure: no navigation, no param strip, no state change. Any host that renders
  a LoadingScreen while `jwt_redeem_ready` (as komodo's router did) spins
  **forever**: the URL keeps `redeem_ready=true`, and a manual refresh re-fires
  the exchange against the one-shot pending state (401, burning one of the
  5-per-15 s limiter attempts — see (d)).
- Harness evidence (`exchange-error`, pre-fix): replayed 401 → no navigation for
  the whole 8 s observation, last LoadingScreen state `on` indefinitely (M5);
  post-fix, komodo converges in-document (settled-failed → `/login`, exactly one
  document load, zero residual over 60 s) — but the library still offers
  embedders no failure path.
- Success-path semantics (`mogh_ui/dist/auth/utils.js`, `sanitizeQueryInner`):
  control flow = delete `redeem_ready|totp|passkey` from the query +
  `location.replace(origin+pathname+query)` — a **full-page reload** on every
  successful login. That reload re-enters any forward-auth gateway in front of
  the app (see (e)), and it is why a failed-redeem spinner can't be fixed from
  inside the library without an in-document path.
- Suggested direction: an `onError` that strips the redeem params and navigates
  to the login route in-document; replace the sanitize reload with
  router-state updates where a router is available.

### (d) komodo core — auth rate limiter keys by IP, which locks out shared-egress deployments

**Title:** `Auth rate limit (5 attempts / 15 s) keyed by peer IP locks out all users behind one proxy egress`

**Body skeleton:**

- Observed on this harness (core `2.3.3`, `auth_rate_limit_max_attempts` unset →
  default 5): the wire answers a replayed exchange with `401 … You have 4
  attempts remaining` — failed attempts share one per-IP budget, and a client
  loop that re-fires the exchange exhausts the budget into 429s ("7 exchanges /
  0 authed" in moghtech/komodo#1665 is this shape). Harness evidence:
  `exchange-error`'s replay 401 visibly burns budget; the suite paces all
  scenarios ≥16 s apart for exactly this reason (README "Verify suite").
- Topology (the reporter's shape, mirrored by the harness Caddy front): an
  authenticating gateway terminates all client connections, so core sees ONE
  peer IP for every user — one user's failure loop (or one office's NAT) can
  lock out everyone behind that egress for the window.
- Suggested direction: key the limiter by something the gateway attests
  (`X-Forwarded-For` trust configuration, session id, or client identity), or
  make the key + trusted-proxy count configurable; document the interaction
  with `oidc_auto_redirect` loops (a redirect loop is exactly the failure mode
  that burns this budget fastest).

### (e) OPEN QUESTION — forward-auth session interplay with the post-exchange navigations (M3, mock-limited)

**Title (question form):** `Does a forward-auth gateway's session survive the OAuth token redemption instant — and which of the post-exchange navigations does it break?`

**Body skeleton (framed as a question, not a claim — the harness mock CANNOT
express this):**

- The harness mock's portal session **survives** token redemption, so every
  post-exchange navigation (mogh_ui's sanitize reload on success; komodo's §7.7
  redirect; the failure-path convergence) re-enters the komodo vhost through the
  gate and returns 200 — M3's bounce/loop (forward-auth session consumed at the
  redemption instant → the post-exchange reload 302s to the portal → …) was
  **not reproducible** and no `/verify` 401/503 storm appears in any ndjson
  (BASELINE "M3 non-reproduction" above).
- Post-fix there are up to TWO navigations after a successful exchange (sanitize
  reload; plus the §7.7 redirect only when the watchdog path was taken) and ONE
  in-document convergence on failure (no reload). If a production Authelia-class
  gateway invalidates its session at the redemption instant, which navigation
  bounces first, and does the loop re-arm the redeem (the URL still carrying
  `redeem_ready=true` through the portal bounce) — re-burning the one-shot and
  the (d) limiter budget?
- Ask for upstream: confirmation of the intended gateway contract at the
  redemption instant, so the client-side failure paths can be designed against
  reality rather than the mock's permissive behavior.

---

*Metadata (post-fix section): produced by Task 11 (fresh runs, 2026-10-02
02:14–02:25 -03:00); harness per README "Run" (podman shim,
`compose/oidc-dev.compose.yaml`, `oidc-provider@9.12.2`); suite at HEAD
`9d9a38a88` (verify.mjs identical to `fa53da3c0`); core image
`localhost/komodo-oidc-dev-core` `5190032c1dbe` built from that HEAD; raw ndjson
evidence in gitignored `compose/oidc-dev/out/`; run stdout archived by the task
outside the repo.*
