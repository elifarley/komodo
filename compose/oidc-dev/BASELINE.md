# Pre-fix baseline — mechanisms reproduced (fresh runs, gate passed)

- **Date:** 2026-10-02 (batch runs 00:10:04–00:16:16, host local time -03:00;
  `exchange-error` re-run at 00:30:25 — provenance note in its section)
- **Suite commit / HEAD:** `fa53da3c0` — `compose/oidc-dev/verify.mjs` exactly as
  committed there (no local edits); branch `komodo-oidc-login-jwt-redeem-race-fix-1665`
  (pre-rewrite hash; full history on the fork's
  `komodo-oidc-login-jwt-redeem-race-fix-1665-archive` branch — same note applies
  to every commit hash in this document, see the post-fix provenance)
- **UI under test:** **stock v2.3.3** — last commit touching `ui/` is the `v2.3.3`
  tag commit itself (`780ac68b9`); the branch carries none of the fix's code yet
  (fix implementation not started). Core image = digest-pinned `ghcr.io/moghtech/komodo-core@sha256:bca73d0e…`
  (tag `2.3.3`).
- **Harness origin:** podman shim (`DOCKER_HOST=unix:///run/user/1000/podman/podman.sock`
  + standalone `docker-compose`); all browser-facing origins carry `:8443`
  (rootless podman cannot publish privileged ports — README Deviations 1). Mongo 8,
  core (branch UI build), oidc-mock (`oidc-provider@9.12.2`), Caddy 2.11, delay sidecar.
- **Method:** all 7 scenarios re-run **fresh** for this baseline (the verify suite's
  cached `out/*.ndjson` moved aside before the first run — none of the excerpts below is a
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

**Gate verdict: ≥1 mechanism reproduced (M1, M2, M5) → PROCEED to the fix implementation.**

> **Post-fix results:** the second half of this document (same harness,
> `--post-fix` enforced, branch UI) is the "Post-fix run" section at
> the bottom — **all seven scenarios green**. `m1-seeded` reached green only via
> the `641f966da` pre-arm fix, which the first post-fix run exposed
> (FAIL → root cause → fix → PASS; resolution below), and the upstream issue
> drafts close the section.

| Scenario | Result | Mechanism signal |
|---|---|---|
| `success` | PASS (7/7) | environment row — no mechanism, regression guard |
| `latency` | PASS (8/8) | environment row with the knob — round-trip 2027 ms ≥ 2000 ms |
| `m1-seeded` | PASS (4/4) | **M1 REPRODUCED** — stale-token reads fire during pending |
| `m2-forced` | PASS (4/4 +1 SKIP) | **M2 REPRODUCED** — silent `add_and_change` drop |
| `exchange-error` | PASS (3/3 +2 SKIP) | **M5 REPRODUCED** — 401 → eternal spinner |
| `hung` | PASS (3/3 +3 SKIP) | slow success, NOT an eternal spinner (see the `hung` section below) |
| `isolation` | PASS (3/3) | regression guard — gate already isolated pre-fix |

---

## success (environment row)

Stock happy path is healthy: the exchange 200 lands, the very next app request is
authenticated, the ws connects, and the dashboard renders. The window-bound guards
observe **zero** unauth/401/403/auth-5xx rows — nothing else in the login
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
whichever jwt is current to *all* API calls, which is why the residual-count unit counts
auth-bearing 5xx, not just 401/403. After settlement the pointer moves off the seed:

```
{"kind":"tokens","ts_ms":1790910696769,"detail":"TOKENS 1790910696767 {\"current\":\"stale-user\",…}"}
{"kind":"tokens","ts_ms":1790910699010,"detail":"TOKENS 1790910699009 {\"current\":\"6abf067c65cacd7846f1e424\",\"tokens\":[{…stale…},{\"user_id\":\"6abf067c…\",\"jwt\":\"…\"}]}"}
```

**Rejection code is 500, not 401.** Core answers the bad-signature jwt with 500 on
`/user` and `/read/GetCoreInfo` on this build. The original "the server 401s
it" design assumption was already amended to "rejections (observed 500s)"; the
suite's predicate deliberately accepts 401/403/5xx and prints the observed statuses
so the discriminating signal stays *stale-token-authenticated request inside the
window*, not the exact code.

### M1 vs the read-deferral premise — CONFIRMED

The fix defers the always-mounted provider-subtree reads (`useUser` poll, `GetCoreInfo`,
connect effect) behind `enabled: gateOpen && hasJwt` for exactly this surface. The
observation matches the premise precisely: **stale-token reads fire during the
pending window** (`[drive start → exchange 200]`), from `WebsocketProvider`'s
mounted queries, with errors that would latch (`retry: false`). Nothing in the fresh
evidence contradicts the deferral premise; the deferral targets what actually happens.

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

`DELAY_AUTH_MS=15000` (past the fix's 12 s watchdog). Pre-fix there is **no watchdog**,
so the LoadingScreen simply holds for the entire delay and the late 200 then
converges normally — the scenario map's pre-fix "eternal spinner" cell for `hung` is
**refuted for finite delays**; the eternal arm is only reachable by an exchange that
never settles, which a finite delay sidecar cannot produce (that arm belongs to the
post-fix watchdog run). The README's row→scenario map already carries the
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
(README Deviations 6); the row exists to catch an unfiltered redeem-gate MutationCache
subscription in the fix implementation.

```
check: probe failing execute returned non-auth 4xx/5xx (observed 500) PASS
check: no full-page reload to /login within 2s (URL /; marker alive) PASS
check: no LoadingScreen flip within 2s (flip observed: false) PASS
```

---

## Mechanism attribution

| # | Mechanism | Verdict | Evidence |
|---|---|---|---|
| M1 | Stale-token query fire | **REPRODUCED** | `m1-seeded`: stale-value `/user` + `/read/GetCoreInfo` (fetch-shim tail `…stale-signature`) hit core during pending, rejected 500, 1.53 s before the exchange 200 |
| M2 | Silent `add_and_change` drop | **REPRODUCED** | `m2-forced`: upstream 200, zero TOKENS transitions (all `null`), sub-less jwt absent from the store, reload → login chunk + `GetLoginOptions`, no signal |
| M3 | Forward-auth bounce → reload loop | **NOT REPRODUCED** (mock limitation — see below) | `success`/`exchange-error`: the post-exchange and post-replay reloads return 200 straight through the gate; zero `/verify` 503/401 bounces in any ndjson |
| M4 | Latched errors never re-run | **NOT INDEPENDENTLY REPRODUCED** | No dedicated scenario row by design; per the mechanism analysis it is covered by the success-path remount, and `success`'s post-reload authed reads + dashboard + ws assert the recovered state (no residual latched state observed) |
| M5 | Exchange failure → eternal spinner | **REPRODUCED** | `exchange-error`: replayed exchange 401 → no navigation, last loader state `on` indefinitely |
| M6 | Core auto-redirect loop | **OUT BY CONSTRUCTION** | `core-config.toml` pins `oidc_auto_redirect = false`, so the harness cannot produce it, and no loop signature appeared |

### M3 non-reproduction — what it does and does not mean

The mock's portal session **survives token redemption**, so the forward-auth gate
never bounces the post-exchange sanitize reload: every reload of
`/?redeem_ready=true` returns 200 and no scenario shows a `/verify` 401/503 storm or
a portal↔komodo loop. This is a **mock limitation, not an exoneration**: the
reporter's production gateway (Authelia-class) may consume/invalidate its session at
the redemption instant, which is exactly the M3 trigger this mock cannot express.
M3 therefore stays **live for the upstream report** (the report records the
contingency: no komodo-side fix under the pinned dependency), and any loop observed
in a later run must be re-checked against core logs (`invalid peer certificate` /
discovery 500s are the known non-M3 confounders — README's debugging note) before
being attributed.

## Gate decision

**PROCEED.** Three of the six candidate mechanisms reproduce with wire-level
evidence (M1, M2, M5), matching the design premise that the fix must cover all
three regardless of which reproduces first (see the attribution table above). The environment rows (`success`,
`latency`, `isolation`) are green pre-fix, so the post-fix runs have a clean
regression baseline, and `hung`'s pre-fix reality is documented for the hung row's
comparison.

---

*Metadata: produced by the fresh pre-fix runs (2026-10-02 00:10–00:16 -03:00;
`exchange-error` re-run 00:30 -03:00); harness
per README "Run" (podman shim, `compose/oidc-dev.compose.yaml`, digest-pinned core
`sha256:bca73d0e…`, `oidc-provider@9.12.2`); suite at HEAD `fa53da3c0` (pre-rewrite
hash; full history on the fork's `komodo-oidc-login-jwt-redeem-race-fix-1665-archive`
branch); raw ndjson evidence in gitignored `compose/oidc-dev/out/`.*

---

# Post-fix run — `--post-fix` arms enforced

Completes the second half of this document: same harness, same drive, same suite
— core rebuilt to serve the branch fix, every run carrying `--post-fix` so the
fix-dependent assertions were ENFORCED (never SKIPped) and the pre-fix mechanism
assertions SKIPped by design (`reportChecks`).

> **Provenance note:** every commit hash cited in this document (`fa53da3c0`,
> `9d9a38a88`, `49802408e`, `641f966da`, …) is a pre-rewrite hash, unreachable
> from the PR branch's current history; full history lives on the fork's
> `komodo-oidc-login-jwt-redeem-race-fix-1665-archive` branch.

- **Date / builds:** batch 0 — 02:14:55–02:25:29 -03:00 against the
  **pre-pre-arm build** (`5190032c1dbe`, HEAD `9d9a38a88`); batch 1 (final) —
  02:51:17–02:54:55 -03:00 against the **final build** (`28f89a5be8af`, HEAD
  `641f966da`); batch 2 (canonical) — 08:58–09:04 -03:00 against the SAME final
  build (image id re-verified unchanged: `28f89a5be8af`). Individual runs, ≥16 s
  apart — the per-IP limiter discipline. Batch 0 first ran every scenario and
  EXPOSED a real fix defect (m1-seeded FAIL, root-caused below); `641f966da`
  (module-scope pre-arm, reviewed) closed it, and batch 1 re-baselined four rows
  on the final image (`success`, `m1-seeded`, `hung`, `isolation`). The remaining
  three rows originally stood on batch 0 under a transfer argument that did not
  survive scrutiny — batch 0's own `exchange-error` ndjson shows the pre-arm
  gap firing in that scenario (−16 ms rows, detailed below the verdict table) —
  so batch 2 re-ran them on the final build. Every post-fix row in the table is
  now a final-build run; batch 0's copies are historical only.
- **Suite:** batch 0 ran `verify.mjs` byte-identical to `fa53da3c0`; batch 1
  runs it with the one-predicate scoping fix from `641f966da` (documented in
  the m1 resolution — the m1 value arm's shim filter self-matched the
  exchange's own stale-jwt dispatch row). All runs carry `--post-fix`
  (fix-dependent checks ENFORCED; pre-fix mechanism assertions SKIPped by
  design).
- **UI under test (batch 1):** the branch fix with pre-arm
  (`49802408e…641f966da`: gate lifecycle incl. the module-scope pre-arm,
  settlement listener, evidence flag, late-success redirect). Core image `localhost/komodo-oidc-dev-core` id `28f89a5be8af`,
  built from HEAD `641f966da`; the running core container was verified to run
  that image (`docker inspect` image sha match) before the batch. Batch 0's
  image (`5190032c1dbe`, HEAD `9d9a38a88`) had its served
  `index-CfUQi4Ph.js` hash matched against the host `yarn build` output.
- **Host build acceptance:** `cd ui && yarn build` clean (exit 0, verified on
  both builds).
- **Evidence:** `out/<scenario>.ndjson` files refreshed by each batch
  (gitignored — batch 1 is the surviving file for its four rows, batch 2 for
  its three); excerpts
  below follow the same elision discipline as the pre-fix sections.

## Verdicts (pre-fix → post-fix)

Every post-fix row below ran on the FINAL build. Batch 1 covered four rows;
batch 2 (canonical) re-ran the remaining three (`latency`, `m2-forced`,
`exchange-error`) after the transfer argument that had let them stand on batch 0
was refuted — see "The retired † argument" below. Batch 0's copies of those
rows are historical only.

| Scenario | Pre-fix | Post-fix (final build) | Fix-dependent arms (`--post-fix`) |
|---|---|---|---|
| `success` | PASS 7/7 | **PASS 7/7** (batch 1) | n/a — regression guard holds: window total 0, sliding 0, ws 101 + on_login, dashboard `/` |
| `latency` | PASS 8/8 | **PASS 8/8** (batch 2) | n/a — regression guard holds: round-trip 2058 ms ≥ 2000 ms |
| `m1-seeded` | PASS 4/4 (M1 REPRODUCED) | **PASS 4/4** (batch 1; was **FAIL 2/4** on batch 0) | zero-stale-reads arm (read deferral): **observed 0** stale reads; value-absence arm PASS (scoped); fresh-pointer PASS |
| `m2-forced` | PASS 4/4 +1 SKIP (M2 REPRODUCED) | **PASS 5/5** (batch 2) | drop flag surfaced in-document on the login page — M2 no longer silent |
| `exchange-error` | PASS 3/3 +2 SKIP (M5 REPRODUCED) | **PASS 3/3** (batch 2; 2 pre-fix arms SKIP) | converged failure in-document (exactly 1 document load, final `/login`) + zero-residual 60 s (0 bad rows, 0 failed ws) |
| `hung` | PASS 3/3 +3 SKIP (slow success) | **PASS 5/5** (batch 1; 1 pre-fix arm SKIP) | watchdog dropped the gate 12.1 s after landing — 3.0 s BEFORE the late 200; zero-residual 60 s (0/0); the late-success redirect recovered the login → landed `/` |
| `isolation` | PASS 3/3 | **PASS 3/3** (batch 1) | n/a — the gate's filtered subscription introduced no gate flip (regression guard holds) |

**7/7 green — the "full suite green post-fix" acceptance criterion is met.**

### The retired † argument — what was wrong, and what replaced it

The previous revision marked `latency` / `m2-forced` / `exchange-error` †
("ran on the pre-pre-arm build; kept because their asserted mechanisms do not
touch the pre-arm window"). That justification was **false for
`exchange-error`**, and batch 0's own ndjson refutes it: the replay document
dispatched auth-bearing `GET /user` + `POST /read/GetCoreInfo` BEFORE the redeem
dispatch — fetch-shim `ts_ms 1790918528200` and `…528200` vs the exchange
dispatch at `…528202` (−2 ms); wire completions `1790918528.2028` /
`1790918528.202812` vs the 401 at `1790918528.2185` (−16 ms) — both rows
`Referer`-pinned by Caddy to `/?redeem_ready=true`, i.e. sent by the redeem
document itself. That IS the parent-first gap the pre-arm closes, firing in
exactly the scenario the old text claimed was untouched. (Recorded in full as
PRE-ARM PROOF in the m1 section below.)

The two-part transfer argument, stated correctly — and mooted by batch 2:
1. **Pre-arm window:** the module-scope pre-arm defers the redeem document's
   own provider reads until the gate closes. Batch 0's `exchange-error` rows
   prove the gap was real in a second scenario (not just `m1-seeded`); batch 2
   proves the fix closes it there too — zero fetch rows of any kind between the
   replay document load and the exchange dispatch.
2. **Post-settlement:** `enabled = gateOpen && hasJwt` keeps the provider reads
   off because the settlement hygiene (`LOGIN_TOKENS.remove_all`) empties the
   store — `hasJwt` is false until a real login re-stores a token, so the
   post-settlement assertions transfer across builds.

Since part 1 was a live defect inside a † row's own scenario, no transfer was
sound; the rows were re-run (batch 2), and batch 0's three rows are kept as
history only.

## m2-forced — the silent drop now surfaces (M2 closed at the komodo layer)

Pre-fix: upstream 200 with a sub-less jwt → `add_and_change` early-returns on
falsy `sub` (`mogh_auth_client/dist/tokens.js`: `if (!user_id) return;`), zero
TOKENS transitions, reload lands on `/login` with **no signal**.

Post-fix run (batch 2, final build — canonical; batch 0 had already passed the
same arms on the pre-pre-arm build, historical): the same drive (route
interception rewrites `body.jwt` to the sub-less token; upstream still 200),
exchange at `ts=1790942436.108`:

```
PASS token-store shim evidenced (>=1 TOKENS row captured)
PASS upstream exchange 200 observed (the drop is client-side; ts=1790942436.108)
PASS exchanged (sub-less) jwt never lands in the token store (silent drop)
PASS silent drop path: reload lands on /login (observed /login)
PASS post-fix: drop flag surfaced in-document on the login page
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

Post-fix run (batch 2, final build — canonical): the two pre-fix arms SKIPped
as designed, both fix-dependent arms PASSED (replay 401 at
`ts=1790942487.047`):

```
PASS replayed exchange 401 observed (one-shot consumed session; ts=1790942487.047)
SKIP (pre-fix mechanism assertion; not applicable with --post-fix) pre-fix: no navigation for 8s after the 401 (URL still redeem_ready; observed /login)
SKIP (pre-fix mechanism assertion; not applicable with --post-fix) pre-fix: eternal LoadingScreen (still up at end of observation; last state: off)
PASS post-fix: in-document convergence to /login (final /login; document loads for the replay: 1)
PASS zero-residual 60s window (unauth-or-401/403-or-auth-5xx app rows: 0; failed ws handshakes: 0)
```

Batch 0's copy of this row (pre-pre-arm build — historical, and instructive):
the SAME two fix-dependent arms PASSED, but the run's own ndjson also carried
the −16 ms rows documented above and as PRE-ARM PROOF below — the reason this
row could not stand on batch 0. Batch 2's ndjson shows the pre-arm engaged:
between the replay document load (`1790942486.976`) and the exchange dispatch,
the fetch shim logged **zero** rows — the exchange is that document's first API
call — where batch 0 had the two auth-bearing provider reads at −2 ms (shim) /
−16 ms (wire).

The settled-failed path converged the SAME document to `/login` — the
replay produced **exactly one** document load (no sanitize reload, no
retry-navigation), the URL/params were stripped via `history.replaceState`, and
the "Login didn't complete" notification carried the signal. Over the
observation's full 60 s window: zero unauth/401/403/auth-5xx rows and zero
failed ws handshakes — nothing re-fires the exchange, so the limiter budget is
no longer burning (pre-fix, a user-stuck spinner plus any reload loop would
exhaust the 5-per-15 s budget into 429s; draft issue (d) below).

## hung — watchdog converges, then the late success recovers (watchdog + late-success redirect closed)

`DELAY_AUTH_MS=15000`, past the 12 s watchdog. Pre-fix reality: no
watchdog, one continuous spinner for 15.6 s, then the late 200 converged
normally (slow success).

Post-fix run (batch 1, final build) — the pre-fix arm SKIPped; all three
fix-dependent arms PASSED:

```
DOC    1790920382363  GET /?redeem_ready=true 200
LOADER 1790920382486  on     (doc+123 ms)   ← pre-armed pending: LoadingScreen immediately
LOADER 1790920394468  off    (doc+12105 ms) ← watchdog dropped the gate — 3040 ms BEFORE the late 200
req    1790920397508  POST /auth/login/ExchangeForJwt 200 (round-trip 15.043 s)
TOKENS 1790920397511  {"current":"6abf067c…"}   ← the LATE 200 still stored its token
LOADER 1790920397779 on / 1790920398080 off    ← late-success redirect transit
final URL: /  (late-success redirect: login page found the fresh flag + jwt and sent the user to /)
PASS post-fix: watchdog dropped the gate BEFORE the late 200 (loader-off observed pre-settlement)
PASS post-fix: zero-residual 60s window after the watchdog settlement (0; failed ws: 0)
PASS post-fix: watchdog converges (gate drops -> /login, then the late-success redirect recovers)
```

This is the full redeem-gate sequence working end-to-end, now with the pre-arm
engaged: the LoadingScreen is up from doc+123 ms (module-scope pre-arm), the
watchdog fired at doc+12105 ms and settled-failed the gate, the user landed on
`/login` instead of spinning, and when the exchange finally returned 200 three
seconds later, mogh_ui's own handler re-stored the token and the one-shot late-success
redirect (fresh `ok` flag + jwt present in the store →
`location.replace(backto ?? "/")`) recovered the login. Zero residual over the
60 s window. (Batch 0 had already passed this row on the pre-pre-arm build —
same three arms; the watchdog path was never pre-arm-sensitive, since the
mutation's own settlement handles both.)

## m1-seeded — read deferral: **FAIL on batch 0 → PASS on the final build** (m1 criterion MET)

### Batch 0 — the failure that found the defect (image `5190032c1dbe`, HEAD `9d9a38a88`)

Verbatim from the batch-0 run (exit 1):

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

What batch 0's ndjson proved (both sides, from this one file): the deferral IS
in force during actual pending — zero `/user|/read` fetches in
[exchange dispatch → 200] — but the two stale reads escape BEFORE the flip, with
the same shape as the pre-fix batch (reads at `…697471/472` vs dispatch `…477`).

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
3. A render-phase flip inside a CHILD cannot cover an ANCESTOR's same-commit
   observers. The `router.tsx` comment ("onMutate … flips the gate to `pending`
   before the snapshot read below, so render #1 is already the LoadingScreen")
   was true for Router's own output only. This also corrects the pre-fix premise
   reading above: the stale reads never fired "during pending" — they fire in
   the same commit as the arm, pre-dispatch; the check window
   ([drive start → exchange 200]) simply includes that pre-arm gap.

### The fix — module-scope pre-arm (`641f966da`, reviewed)

Exactly the minimal remedy batch 0's analysis sketched: `redeem-gate.ts`
initializes `state = "pending"` at import (before any React render) when
`location.search` carries `redeem_ready=true`, and arms the watchdog from the
same point — mirroring mogh_ui's own module-level `jwt_redeem_sent` guard. The
provider's FIRST render already sees the gate closed; the later real `onMutate`
flip is idempotent (equality guard) and its watchdog arm a no-op (already set).
Normal loads (no param) stay `idle`, byte-identical. The pre-armed watchdog is
also defensive: if mogh_ui drift ever stopped firing the mutation, the window
still converges to `settled-failed` (with its `remove_all` hygiene) within
`WATCHDOG_MS`.

Companion checker fix in the same commit (verify.mjs, one predicate): the m1
value arm's shim filter had matched ANY fetch row carrying the stale jwt tail
before the wire exchange ts — but the redeem request itself legitimately
carries the stale jwt (it IS the credential being exchanged), and the shim logs
that row at DISPATCH, necessarily before the wire completion ts. Once the real
leaks were closed, the exchange self-matched and false-failed the absence arm
(first post-pre-arm run: wire observed 0, yet the value arm FAILED on the
exchange dispatch row alone). The filter is now scoped to the same
`^/(user|read)` paths the wire arm scopes — pre-fix behavior unchanged,
post-fix absence meaningful.

### Batch 1 — PASS on the final build (image `28f89a5be8af`, HEAD `641f966da`)

```
PASS exchange 200 observed (pending window closed; ts=1790920316.824)
PASS stale-token requests fire during the redeem window (wire: auth+rejected in [drive start -> exchange 200]; observed 0, statuses -)
PASS stale token VALUE confirmed on those requests (fetch shim tail …hwIjoxfQ.stale-signature)
PASS fresh token stored after the exchange (current pointer moved off stale-user)
SCENARIO m1-seeded PASS   (exit 0)
```

The ndjson shows the pre-arm doing exactly what the root cause demanded: the
redeem document loads at `…315199`, the exchange dispatch fetch goes out at
`…315295` (doc+96 ms) — and **the exchange itself is the ONLY fetch in
[doc load → 200]**; the LoadingScreen row lands doc+117 ms; zero stale-tail
fetches to `/user|/read` anywhere before the 200. The scenario-map arm ("zero such
rows") holds on the final build; the m1 acceptance criterion is met.

### PRE-ARM PROOF — the parent-first gap fired in a second scenario (batch-0 `exchange-error`)

Independent confirmation of the root cause, from a run whose scenario the
earlier revision of this document believed untouched by the pre-arm change.
Batch 0's `exchange-error` ndjson (pre-pre-arm build): the replay document
dispatched auth-bearing `GET /user` + `POST /read/GetCoreInfo` BEFORE the
exchange — the fetch shim logged both at `ts_ms 1790918528200` against the
exchange dispatch at `…528202` (−2 ms), the wire shows their completions at
`1790918528.2028` / `…202812` against the 401 at `1790918528.2185` (−16 ms),
and Caddy pinned both rows to the redeem document
(`Referer: …/?redeem_ready=true`). Same shape as m1's leak: provider reads
committed while the gate was still open. They answered 200 (the leg-1 jwt was
still stored), so nothing rejected — the harm here is evidentiary, not budget:
the gap was real outside `m1-seeded`, and this document mis-assessed its own
evidence in claiming otherwise.

Batch 2 (final build) closes the loop in this same scenario: between the replay
document load (`1790942486.976`) and the exchange dispatch, the fetch shim
logged zero rows — the exchange is the document's first API call (see the
`exchange-error` section above).

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
  post-exchange navigation (mogh_ui's sanitize reload on success; komodo's
  late-success redirect; the failure-path convergence) re-enters the komodo vhost through the
  gate and returns 200 — M3's bounce/loop (forward-auth session consumed at the
  redemption instant → the post-exchange reload 302s to the portal → …) was
  **not reproducible** and no `/verify` 401/503 storm appears in any ndjson
  (BASELINE "M3 non-reproduction" above).
- Post-fix there are up to TWO navigations after a successful exchange (sanitize
  reload; plus the late-success redirect only when the watchdog path was taken) and ONE
  in-document convergence on failure (no reload). If a production Authelia-class
  gateway invalidates its session at the redemption instant, which navigation
  bounces first, and does the loop re-arm the redeem (the URL still carrying
  `redeem_ready=true` through the portal bounce) — re-burning the one-shot and
  the (d) limiter budget?
- Ask for upstream: confirmation of the intended gateway contract at the
  redemption instant, so the client-side failure paths can be designed against
  reality rather than the mock's permissive behavior.

### (f) mogh_ui — `backto` query param flows unvalidated into `location.replace`

**Title:** `Open redirect: the `backto` query param is passed to `location.replace` without any origin validation`

- Code-verified (no harness scenario drives a hostile `backto`):
  `mogh_ui/dist/auth/login/index.js` `maybeNavigate` →
  `location.replace(new URLSearchParams(location.search).get("backto") ?? "/")`
  — any absolute URL in `backto` navigates the user off-site after login, and
  hosts inherit the shape (komodo's late-success redirect reads `backto` the
  same way).
- Ask: same-origin validation (or relative-path-only) upstream, so every
  embedder inherits the fix.

### One-line ask (not drafted)

- mogh_ui: consider exporting the token-store key and redeem lifecycle seams so
  hosts can unit-test redeem integrations without a full harness.

---

*Metadata (post-fix section): produced by the post-fix runs — batch 0 2026-10-02
02:14–02:25 -03:00 (HEAD `9d9a38a88`, image `5190032c1dbe`, verify.mjs as
committed at `fa53da3c0`); batch 1 (final) 02:51–02:55 -03:00 (HEAD
`641f966da`, image `28f89a5be8af`, verify.mjs with `641f966da`'s one-predicate
m1 scoping fix); batch 2 (final, canonical) 08:58–09:04 -03:00 (same HEAD
`641f966da`, same image `28f89a5be8af` — id re-verified on the running
container before the batch; the re-run rows are `latency` 08:58, `m2-forced`
09:00, `exchange-error` 09:01, each ≥16 s apart). Harness per README "Run"
(podman shim, `compose/oidc-dev.compose.yaml`, `oidc-provider@9.12.2`); raw
ndjson evidence in gitignored `compose/oidc-dev/out/` (batch 2 files are the
surviving evidence for its three rows, batch 1 for its four); run stdout
archived by the task outside the repo. All commit hashes are pre-rewrite; full
history on the fork's `komodo-oidc-login-jwt-redeem-race-fix-1665-archive`
branch.*
