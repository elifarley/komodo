# Pre-fix baseline — mechanisms reproduced (Task 5, PHASE-1 GATE)

- **Date:** 2026-10-02 (runs 00:10:04–00:16:16, host local time -03:00)
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
  evidentiary rows verbatim except that oversized jwt strings are cut to `…` — the
  `out/` files carry the full values.

**Gate verdict: ≥1 mechanism reproduced (M1, M2, M5) → PROCEED to Phase 2 (Tasks 6–10).**

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
{"kind":"req","ts":1790910699.008,…,"method":"POST","url":"/auth/login/ExchangeForJwt","auth":false,"status":200}   ← window closes 1.53 s LATER
```

Wire rows prove auth-header **presence** + rejection + timing (Caddy redacts the
value); the fetch-shim rows prove the **value** — those two requests carried the
seeded stale token, not the fresh one. The same shim shows the stale token is also
attached to the `ExchangeForJwt` call itself (ts 1790910697477) — mogh_ui attaches
whichever jwt is current to *all* API calls, which is why §6's residual unit counts
auth-bearing 5xx, not just 401/403. After settlement the pointer moves off the seed:

```
{"kind":"tokens","ts_ms":1790910696769,"detail":"TOKENS 1790910696767 {\"current\":\"stale-user\",…}"}
{"kind":"tokens","ts_ms":1790910699009,"detail":"TOKENS 1790910699009 {\"current\":\"6abf067c65cacd7846f1e424\",\"tokens\":[{…stale…},{\"user_id\":\"6abf067c…\",\"jwt\":\"…\"}]}"}
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
{"kind":"req","ts":1790910746.6,…,"method":"GET","url":"/assets/login-DoZQWzrW.js","auth":false,"status":200}   ← post-exchange reload loads the LOGIN chunk
{"kind":"req","ts":1790910746.64838,…,"method":"POST","url":"/auth/login/GetLoginOptions","auth":false,"status":200}
checks: sub-less jwt never lands in the token store PASS · reload lands on /login PASS
```

Every TOKENS row captured reads `null` and a grep for the sub-less jwt's payload
across the whole ndjson returns 0 hits — `add_and_change`'s early return dropped it
silently. The only user-visible consequence is the login page; the post-fix
"drop flag surfaced on the login page" check is the `SKIP`ped fix-dependent arm.

## exchange-error — **M5 REPRODUCED**

Leg 1 completes a full login (dashboard). Replaying `/?redeem_ready=true` re-fires
the exchange against the ONE-SHOT pending state → 401 (this also burns one of the
5-per-15s limiter attempts; a UI loop that re-fires exhausts the budget and then
429s — the closest analogue to the reporter's "7 exchanges / 0 authed"):

```
{"kind":"req","ts":1790910774.1744032,…,"method":"POST","url":"/auth/login/ExchangeForJwt","auth":false,"status":200}   ← leg 1
{"kind":"req","ts":1790910779.3302882,…,"method":"GET","url":"/?redeem_ready=true","auth":false,"status":200}           ← replay navigation
{"kind":"fetch","ts_ms":1790910779385,"path":"/auth/login/ExchangeForJwt","auth_tail":"zGIRvGDf47C0zW-MtCIJQDrk"}        ← still-stored jwt attached
{"kind":"req","ts":1790910779.4028575,…,"method":"POST","url":"/auth/login/ExchangeForJwt","auth":true,"status":401,"duration_s":0.014221834}
{"kind":"loader","ts_ms":1790910779445,"state":"on","detail":"LOADER 1790910779445 on"}                                  ← last loader row, ever
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

*Metadata: produced by Task 5 (fresh runs, 2026-10-02 00:10–00:16 -03:00); harness
per README "Run" (podman shim, `compose/oidc-dev.compose.yaml`, digest-pinned core
`sha256:bca73d0e…`, `oidc-provider@9.12.2`); suite at HEAD `fa53da3c0`; raw ndjson
evidence in gitignored `compose/oidc-dev/out/`.*
