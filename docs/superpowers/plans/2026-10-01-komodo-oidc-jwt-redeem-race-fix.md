# Komodo OIDC JWT Redeem Race Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix moghtech/komodo#1665 — after a successful OIDC `ExchangeForJwt`, the UI never sends the returned JWT — via a settlement gate in komodo's `ui/src`, verified by a docker harness that reproduces the failure before the fix lands.

**Architecture:** Embrace-the-reload posture (spec §7, post-roast round 4): mogh_ui 1.2.7's success path reloads the document and no komodo hook can precede that navigation, so komodo (a) arms a watchdog + evidence flag from a module-scope `MutationCache` config (synchronous, inside `execute`), (b) keeps app queries + the update websocket behind a `pending`-only gate, (c) converges definite failures in-document (`remove_all` + `history.replaceState` + notification), and (d) one-shot-redirects a late success off `/login`. Phase 1 (Tasks 1–5) builds `compose/oidc-dev` and MUST name the confirmed mechanism before any §7 code (Tasks 6–10) lands.

**Tech Stack:** React 19 + TypeScript (komodo `ui/`), @tanstack/react-query 5.102.4 (pinned), mogh_ui 1.2.7 / mogh_auth_client 1.7.1 (pinned — no dep changes), docker compose (mongo + digest-pinned komodo-core + node-oidc-provider mock + Caddy), Playwright (headless chromium, dev-only, host-installed for the harness driver).

**Testing note (deviation from classic TDD):** komodo's `ui/` has no unit-test framework and the spec forbids adding one (§3). Per-task verification is `yarn build` (tsc, strict) for code tasks; behavioral verification is the Task 4 harness suite. TDD's red-green shape is preserved at the system level: Task 5 runs the suite against pre-fix code (red on the fix assertions), Tasks 6–10 make it green.

**Spec:** `docs/superpowers/specs/2026-10-01-komodo-oidc-login-jwt-redeem-race-fix-1665-design.md` (authoritative; section refs below).

---

### Task 1: Harness skeleton — compose, mongo, digest-pinned core

**Goal:** `docker compose -f compose/oidc-dev.compose.yaml up` boots mongo + komodo-core (stock UI) and core reports healthy on the proxy-less path.

**Files:**
- Create: `compose/oidc-dev.compose.yaml`
- Create: `compose/oidc-dev/README.md`

**Acceptance Criteria:**
- [ ] `docker compose -f compose/oidc-dev.compose.yaml up -d mongo core` ends with both containers running
- [ ] `curl -s -o /dev/null -w '%{http_code}' http://localhost:9120` → `200` (core serves stock UI directly)
- [ ] The core image reference in the compose file is digest-pinned

**Verify:** `docker compose -f compose/oidc-dev.compose.yaml ps --format '{{.Service}} {{.Status}}'` → both `Up`.

**Steps:**

- [ ] **Step 1: Pin the core image digest**

```sh
docker buildx imagetools inspect ghcr.io/moghtech/komodo-core:v2.3.3 | grep -i digest | head -1
```
Record the manifest digest (`sha256:…`) — substitute it for `PINNED_DIGEST` in Step 2.

- [ ] **Step 2: Write `compose/oidc-dev.compose.yaml`**

```yaml
# OIDC redeem-race harness (moghtech/komodo#1665). See compose/oidc-dev/README.md.
# Up:  docker compose -f compose/oidc-dev.compose.yaml --env-file compose/oidc-dev/.env up -d --build
name: komodo-oidc-dev

services:
  mongo:
    image: mongo:8
    restart: unless-stopped
    volumes:
      - oidc-dev-mongo:/data/db
    command: [--replSet, rs0, --bind_ip_all]
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "try { rs.status().ok } catch (e) { rs.initiate() }"]
      interval: 10s
      timeout: 5s
      retries: 12

  core:
    # Digest pinned in compose/oidc-dev/.env (KOMODO_CORE_IMAGE) — see README step 1.
    image: ${KOMODO_CORE_IMAGE}
    restart: unless-stopped
    depends_on:
      mongo:
        condition: service_healthy
    environment:
      KOMODO_DATABASE_URL: mongodb://mongo:27017/komodo?replicaSet=rs0
      KOMODO_HOST: https://komodo.oidctest.localhost
      KOMODO_LOCAL_AUTH: "true"
      KOMODO_OIDC_ENABLED: "false"        # flipped by Task 3's mounted config
      KOMODO_OIDC_AUTO_REDIRECT: "false"  # pinned per spec §6 — M3/M6 discrimination
      KOMODO_JWT_SECRET: oidc-dev-jwt-secret-not-for-production
    ports:
      - "9120:9120"
    volumes:
      - oidc-dev-config:/config
      - ./oidc-dev/core-config.toml:/config/config.toml:ro
      - oidc-dev-repo-cache:/config/repo-cache

volumes:
  oidc-dev-mongo:
  oidc-dev-config:
  oidc-dev-repo-cache:
```

- [ ] **Step 3: Write `compose/oidc-dev/.env`** (gitignored content pattern — check `git check-ignore`; if `.env` files are not ignored in this repo, name it `.env.example` + copy at runtime; the docker `--env-file` flag takes any name)

```sh
# Pin the digest you recorded in Step 1:
KOMODO_CORE_IMAGE=ghcr.io/moghtech/komodo-core@sha256:PINNED_DIGEST
```

- [ ] **Step 4: Write `compose/oidc-dev/core-config.toml`** (minimal file config; field names from `config/core.config.toml` — verify the `oidc_*` block against that file when wiring Task 3)

```toml
# Harness core config. Never use these secrets outside compose/oidc-dev.
host = "https://komodo.oidctest.localhost"
local_auth = true
oidc_enabled = false
oidc_auto_redirect = false
jwt_secret = "oidc-dev-jwt-secret-not-for-production"
```

- [ ] **Step 5: Write `compose/oidc-dev/README.md`** — run instructions (the `docker compose` line from the yaml header), the digest-pinning step, and the pin: `node-oidc-provider` version `11.10.1` (the version this harness's mock is written against; bump only with a re-run of the full suite).

- [ ] **Step 6: Boot and verify**

```sh
docker compose -f compose/oidc-dev.compose.yaml --env-file compose/oidc-dev/.env up -d mongo core
docker compose -f compose/oidc-dev.compose.yaml ps --format '{{.Service}} {{.Status}}'
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9120
```
Expected: both `Up`; `200`.

- [ ] **Step 7: Commit** — `hug a compose/oidc-dev.compose.yaml compose/oidc-dev/README.md compose/oidc-dev/core-config.toml` then `hug c -F - <<'EOF' … feat(harness): oidc-dev skeleton — digest-pinned core + mongo … EOF` (do NOT commit `compose/oidc-dev/.env`).

### Task 2: OIDC mock provider (node-oidc-provider) + forward-auth endpoint

**Goal:** `oidc-mock` service issues real OIDC codes for a static user (authorization-code + PKCE, `client_secret_basic`) and exposes the `/verify` endpoint Caddy's `forward_auth` will call.

**Files:**
- Create: `compose/oidc-dev/oidc-mock/package.json`
- Create: `compose/oidc-dev/oidc-mock/index.mjs`
- Create: `compose/oidc-dev/oidc-mock/Dockerfile`
- Modify: `compose/oidc-dev.compose.yaml` (add the `oidc-mock` service)

**Acceptance Criteria:**
- [ ] `curl -s http://oidc-mock:3344/.well-known/openid-configuration` (from inside the compose network) returns `200` with `authorization_endpoint` present
- [ ] `curl -s -o /dev/null -w '%{http_code}' http://oidc-mock:3344/verify` without a session → `401`

**Verify:** the two curls above via `docker compose … exec core sh -c 'wget -qO- …'` or a temporary `docker run --network` curl.

**Steps:**

- [ ] **Step 1: `oidc-mock/package.json`**

```json
{
  "name": "komodo-oidc-mock",
  "private": true,
  "type": "module",
  "dependencies": { "oidc-provider": "11.10.1" },
  "scripts": { "start": "node index.mjs" }
}
```

- [ ] **Step 2: `oidc-mock/index.mjs`**

```js
// Minimal OIDC provider for the komodo redeem-race harness.
// Issues authorization codes for a static user; auto-approves consent;
// exposes /verify for Caddy forward_auth (session cookie check).
import Provider from "oidc-provider";
import http from "node:http";

const issuer = process.env.MOCK_ISSUER ?? "https://portal.oidctest.localhost";

const provider = new Provider(issuer, {
  clients: [
    {
      client_id: "komodo-harness",
      client_secret: "komodo-harness-secret",
      redirect_uris: ["https://komodo.oidctest.localhost/auth/oidc/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
      scope: "openid email profile",
    },
  ],
  claims: { profile: ["email", "sub"] },
  features: { devInteractions: { enabled: true } }, // built-in login/consent forms
  findAccount: async (_ctx, id) => ({
    accountId: id,
    claims: async () => ({ sub: id, email: `${id}@oidctest.local` }),
  }),
  pkce: { required: () => true },
  // Auto-approve consent so the Playwright drive is deterministic:
  async loadExistingGrant(ctx) {
    const grant = new (provider.Grant)();
    grant.addOIDCScope("openid email profile");
    grant.accountId = ctx.account.accountId;
    grant.clientId = ctx.client.clientId;
    await grant.save();
    return grant;
  },
});

http
  .createServer(provider.callback)
  .listen(3344, () => console.log("oidc-mock on :3344"));
```

Note: `node-oidc-provider`'s default login form posts a static user id typed into the
dev interaction; the Playwright drive fills it. `/verify` below is the forward-auth check —
`provider.Session.get(req)` resolves the provider session from the request's cookies.

- [ ] **Step 3: append to `oidc-mock/index.mjs`** (replace the plain `createServer` block)

```js
http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    if (url.pathname === "/verify") {
      try {
        const session = await provider.Session.get(req);
        if (session && (await session.userId())) return res.writeHead(200).end("ok");
      } catch { /* fallthrough */ }
      return res.writeHead(401).end("unauthorized");
    }
    provider.callback(req, res);
  })
  .listen(3344, () => console.log("oidc-mock on :3344"));
```

- [ ] **Step 4: `oidc-mock/Dockerfile`**

```dockerfile
FROM node:22.12-alpine
WORKDIR /app
COPY oidc-mock/package.json ./
RUN yarn install --frozen-lockfile || yarn install
COPY oidc-mock/index.mjs ./
ENV MOCK_ISSUER=https://portal.oidctest.localhost
EXPOSE 3344
CMD ["yarn", "start"]
```
(Build context is the repo root: `docker compose` builds with `context: .`, `dockerfile: compose/oidc-dev/oidc-mock/Dockerfile`.)

- [ ] **Step 5: add the service to `compose/oidc-dev.compose.yaml`**

```yaml
  oidc-mock:
    build:
      context: ..
      dockerfile: compose/oidc-dev/oidc-mock/Dockerfile
    restart: unless-stopped
    environment:
      MOCK_ISSUER: https://portal.oidctest.localhost
    ports:
      - "3344:3344"
```

- [ ] **Step 6: boot + curls (Acceptance Criteria), then commit** (`feat(harness): oidc-mock provider with forward-auth verify endpoint`).

### Task 3: Caddy reverse proxy (TLS, forward_auth, JSON access log, delay knob) + core OIDC wiring

**Goal:** `https://komodo.oidctest.localhost` terminates at Caddy, authenticates via forward_auth to the mock, proxies to core, and logs every request (headers included) as JSON. Core has OIDC enabled with the mock as provider. A manual browser OIDC login reaches the `/?redeem_ready=true` callback (the pre-fix bug may then be observable live).

**Files:**
- Create: `compose/oidc-dev/Caddyfile`
- Modify: `compose/oidc-dev.compose.yaml` (add `caddy` service; flip core config to OIDC-enabled)
- Modify: `compose/oidc-dev/core-config.toml` (enable OIDC)

**Acceptance Criteria:**
- [ ] `curl -sk -o /dev/null -w '%{http_code}' https://komodo.oidctest.localhost` → `401`-or-redirect-to-portal without a session (forward_auth active)
- [ ] After a portal login, `https://komodo.oidctest.localhost` reaches the Komodo UI
- [ ] `compose/oidc-dev/access.log` contains JSON entries with `request.headers` keys
- [ ] Manual OIDC login ends at `/?redeem_ready=true` → Komodo UI (or the reported login-modal loop — either is a correct baseline)

**Verify:** the curls + `tail -1 compose/oidc-dev/access.log | python3 -m json.tool | head`.

**Steps:**

- [ ] **Step 1: `compose/oidc-dev/Caddyfile`**

```caddy
{
	local_certs
	log {
		output file /data/caddy-internal.log
	}
}

# Portal (mock OIDC provider) — first-party TLS for the drive.
portal.oidctest.localhost:443 {
	tls internal
	reverse_proxy oidc-mock:3344
}

# Komodo behind forward_auth, mirroring the issue reporter's shape.
komodo.oidctest.localhost:443 {
	tls internal
	log {
		output file /data/access.log
		format json
	}
	# LATENCY KNOB (spec §6): delay auth requests; must stay < the 12 s watchdog (§7.1).
	# Bump via compose/oidc-dev/.env DELAY_AUTH_MS. The dedicated past-watchdog row
	# uses DELAY_AUTH_MS=15000 in a separate profile.
	reverse_proxy core:9120 {
		@auth path /auth/login/*
		rewrite @auth /auth{uri}
		header @auth X-Harness-Delay "1"
	}
	forward_auth oidc-mock:3344 {
		uri /verify
	}
}
```

Implementation note: Caddy's `delay` is not a native directive — implement the knob as a
10-line `caddy-l4`-free alternative: a tiny `delay` sidecar or (simpler, chosen) route the
`/auth/login/*` path through a `route` block with Caddy's `handle` + a delay plugin-free
approach: **use Caddy's `reverse_proxy` health-free double-hop through a one-file Node
delay proxy** (`compose/oidc-dev/delay.mjs`: `http` server that `setTimeout(DELAY_AUTH_MS)`
then pipes to `core:9120`). The compose file points the Caddy upstream for `/auth/login/*`
at `delay:9999` instead of `core:9120`.

```js
// compose/oidc-dev/delay.mjs — adds DELAY_AUTH_MS to /auth/login/* only.
import http from "node:http";
const DELAY = parseInt(process.env.DELAY_AUTH_MS ?? "0", 10);
http.createServer((req, res) => {
  const upstream = http.request(
    { host: "core", port: 9120, path: req.url, method: req.method, headers: req.headers },
    (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); },
  );
  req.pipe(upstream);
  if (req.url?.startsWith("/auth/login/") && DELAY > 0) {
    upstream.setTimeout(DELAY); // simplest deterministic delay: stall the upstream request
  }
}).listen(9999);
```

(If the timer-stall approach misbehaves, replace with an explicit `await new Promise(r => setTimeout(r, DELAY))` before dispatching — same file, same knob.)

- [ ] **Step 2: add `caddy` + `delay` services to the compose file**

```yaml
  delay:
    build:
      context: ..
      dockerfile: compose/oidc-dev/oidc-mock/Dockerfile
    command: ["node", "/app/delay.mjs"]
    volumes:
      - ./oidc-dev/delay.mjs:/app/delay.mjs:ro
    environment:
      DELAY_AUTH_MS: ${DELAY_AUTH_MS:-0}

  caddy:
    image: caddy:2.11
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      DELAY_AUTH_MS: ${DELAY_AUTH_MS:-0}
    volumes:
      - ./oidc-dev/Caddyfile:/etc/caddy/Caddyfile:ro
      - ./oidc-dev/access.log:/data/access.log
      - oidc-dev-caddy-data:/data
    depends_on:
      - core
      - oidc-mock

volumes:
  oidc-dev-caddy-data:
```

- [ ] **Step 3: enable OIDC in `compose/oidc-dev/core-config.toml`** — set `oidc_enabled = true` and add the provider block (field names: read the `oidc_provider` docs block in `config/core.config.toml` lines ~249-300 first and mirror the exact structure — `oidc_provider` issuer URL `https://portal.oidctest.localhost`, client `komodo-harness` / `komodo-harness-secret`, method `client_secret_basic`, PKCE required).

- [ ] **Step 4: bring the stack up; run the two Acceptance-Criteria curls; do a manual browser pass through the portal** (visit `https://komodo.oidctest.localhost`, accept the self-signed CA for `*.oidctest.localhost`, log in at the portal with any user id). Confirm the callback lands on `/?redeem_ready=true` and note what the stock (pre-fix) UI does afterward — this is the Task 5 baseline cross-check.

- [ ] **Step 5: Commit** (`feat(harness): caddy forward_auth + access log + delay knob; core OIDC wiring`).

### Task 4: Playwright verification suite (`verify.mjs`)

**Goal:** One script drives the scenario matrix over the Caddy JSON access log + browser instrumentation and emits PASS/FAIL per assertion, per spec §6.

**Files:**
- Create: `compose/oidc-dev/verify.mjs`
- Modify: `compose/oidc-dev/README.md` (run instructions: `npx playwright install chromium` once; `node compose/oidc-dev/verify.mjs [scenario]`)

**Acceptance Criteria:**
- [ ] `node compose/oidc-dev/verify.mjs success` exits 0 on a healthy stack and prints per-assertion PASS lines
- [ ] `node compose/oidc-dev/verify.mjs m1-seeded` seeds the stale token (expired, schema `{current, tokens:[{user_id, jwt}]}`) and asserts stale-token requests during the redeem window (pre-fix run)
- [ ] Every scenario prints a final `SCENARIO <name> <PASS|FAIL>` line and writes per-request rows (url, authorization present, status, ts) to `compose/oidc-dev/out/<scenario>.ndjson`

**Verify:** run both scenarios against the Task 3 stack; expect `success` to PASS its environment assertions and the fix-dependent assertions to be reported as `FIX-DEPENDENT` (skipped pre-fix) so Task 5 can flip them on.

**Steps:**

- [ ] **Step 1: write `compose/oidc-dev/verify.mjs`** — complete driver:

```js
// Scenario driver for the OIDC redeem-race harness (spec §6).
// Usage: node verify.mjs <scenario>   (success | latency | m1-seeded | hung | isolation)
// Reads compose/oidc-dev/access.log (Caddy JSON) + drives headless chromium.
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync } from "node:fs";

const SCEN = process.argv[2] ?? "success";
const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// --- access-log tailer: returns new JSON lines since last poll ---
let logOffset = 0;
function pollLog() {
  const path = new URL("./access.log", import.meta.url).pathname;
  const size = statSync(path).size;
  if (size < logOffset) logOffset = 0; // rotated
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(size - logOffset);
  readSync(fd, buf, 0, buf.length, logOffset);
  logOffset = size;
  return buf.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const APP_FETCH_ORIGINS = ["https://komodo.oidctest.localhost"];
const isAppFetch = (e) =>
  APP_FETCH_ORIGINS.includes(`https://${e.request.host}`) &&
  !e.request.headers?.["Sec-Fetch-Dest"]?.includes("document") &&
  !e.request.uri?.endsWith(".js") && !e.request.uri?.endsWith(".css");
const unauthOrFail = (e) => {
  const auth = e.request.headers?.Authorization ?? e.request.headers?.authorization;
  const status = e.resp_headers?.status ? parseInt(e.resp_headers.status) : e.status;
  return (!auth && !e.request.uri?.startsWith("/auth/login/")) || status === 401 || status === 403;
};

const rows = [];
function record(e) {
  const row = {
    ts: Date.now(), url: e.request.uri,
    auth: !!(e.request.headers?.Authorization ?? e.request.headers?.authorization),
    status: e.resp_headers?.status ?? e.status,
  };
  rows.push(row); return row;
}

const STALE_JWT = [
  "eyJhbGciOiJIUzI1NiJ9", // header
  Buffer.from(JSON.stringify({ sub: "stale-user", exp: 1 })).toString("base64url"), // expired
  "stale-signature",
].join(".");

async function seedStaleToken(context) {
  await context.addInitScript(`
    localStorage.setItem("mogh-auth-tokens-v1", JSON.stringify({
      current: "stale-user",
      tokens: [{ user_id: "stale-user", jwt: ${JSON.stringify(STALE_JWT)} }],
    }));
  `);
}

async function drive(browser, { seedStale = false } = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  if (seedStale) await seedStaleToken(context);
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto("https://komodo.oidctest.localhost");
  await page.getByRole("button", { name: /oidc|single sign/i }).first().click().catch(() => {});
  await page.waitForURL(/portal\.oidctest\.localhost/, { timeout: 20_000 });
  await page.getByRole("button", { name: /sign in|continue/i }).first().click().catch(() => {});
  await page.waitForURL(/komodo\.oidctest\.localhost/, { timeout: 20_000 });
  return { context, page, t0 };
}

// --- scenario assertions (spec §6) ---
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check("exchange 200 observed", (log) => log.some((e) => e.request.uri.includes("/auth/login/ExchangeForJwt") && (e.resp_headers?.status ?? e.status) === 200));
check("authenticated app follow-up <= 3s after exchange", (log, ctx) => {
  const exch = log.filter((e) => e.request.uri.includes("ExchangeForJwt")).at(-1);
  if (!exch) return false;
  return log.some((e) => Date.parse(e.ts ?? e.start) - Date.parse(exch.ts ?? exch.start) <= 3_000
    && (e.request.headers?.Authorization ?? e.request.headers?.authorization) && (e.resp_headers?.status ?? e.status) === 200);
});
check("success-row unauth-or-401 window total <= 4", (log) => /* rows between callback & dashboard */ true);
check("update websocket connected", (log) => log.some((e) => e.request.uri.includes("/ws/update") && (e.status ?? 101) === 101));
check("zero residual after settled-failure (excl /auth/login/*)", (log, ctx) => /* rows in [settle, settle+60s] */ true);
// … scenario composition below …

const log0 = [];
setInterval(() => { for (const e of pollLog()) { record(e); log0.push(e); } }, 250).unref();

const browser = await chromium.launch();
const { context, page, t0 } = await drive(browser, { seedStale: SCEN === "m1-seeded" });
await page.waitForTimeout(SCEN === "hung" ? 20_000 : 8_000);

// dashboard-rendered (§6): URL is / (no redeem_ready) AND a /user GET returned 200 after callback
const dash = rows.some((r) => r.url.endsWith("/user") && r.auth && r.status === 200) && !page.url().includes("redeem_ready");
writeFileSync(`${OUT}${SCEN}.ndjson`, rows.map((r) => JSON.stringify(r)).join("\n"));

let pass = true;
for (const c of checks) {
  let ok; try { ok = await c.fn(log0, { page, dash, rows }); } catch (e) { ok = false; console.error(e); }
  console.log(`${ok ? "PASS" : "FAIL"} ${c.name}`);
  pass &&= ok;
}
console.log(`SCENARIO ${SCEN} ${pass ? "PASS" : "FAIL"}`);
await browser.close();
process.exit(pass ? 0 : 1);
```

The four stubbed `check` bodies marked `true`/`rows` comments are filled in this same task
with the exact window logic from §6 (window `[callback 303 → dashboard rendered]` for
success rows; `[settlement, settlement+60s]` for failure rows; exclusion list
`/auth/login/*`; stale-token detection = `auth && 401` rows inside the pending window
before the exchange response). Each gets a real implementation in Steps 2–3 — the stubs
exist only to fix the file's shape now.

- [ ] **Step 2: implement the window predicates** — replace the stubbed bodies with the §6 logic: find `callback 303` row (document request to `/` carrying `redeem_ready=true`), find `dashboard` row (first authenticated `/user` 200 after exchange), filter `unauthOrFail` rows in-window, assert totals and 15 s sliding max; for failure rows assert the exclusion-listed zero-residual over `[settlement, settlement+60_000]`.

- [ ] **Step 3: scenario composition** — `success` (plain), `latency` (`DELAY_AUTH_MS=2000` env), `m1-seeded` (Step `seedStaleToken`), `hung` (`DELAY_AUTH_MS=15000` — past the watchdog; asserts settled-failed convergence then §7.7 landing post-fix), `isolation` (post-login `page.evaluate(fetch("/execute/StartDeployment", {method:"POST"}))` → expects 4xx and asserts NO LoadingScreen flip and no reload to `/login` within 2 s).

- [ ] **Step 4: run `success` against the stack; fix log-parsing mismatches against real Caddy JSON field names** (`request.headers` casing, timestamp field) until assertions evaluate against real data. Record the two or three field-name adjustments in the README.

- [ ] **Step 5: Commit** (`feat(harness): playwright scenario suite with §6 assertions`).

### Task 5: Pre-fix baseline — reproduce ≥1 mechanism (PHASE-1 GATE)

**Goal:** Run the suite against stock v2.3.3 UI and capture which candidate mechanism(s) (M1/M3/M4/M5/M6) reproduce. **This task gates Tasks 6–10.** If nothing reproduces, STOP and report — do not write §7 code against an unreproduced failure.

**Files:**
- Create: `compose/oidc-dev/BASELINE.md` (findings: which mechanisms reproduced, with log excerpts)

**Acceptance Criteria:**
- [ ] `BASELINE.md` names ≥1 reproduced mechanism with wire-level evidence (ndjson rows)
- [ ] The `m1-seeded` scenario documents whether stale-token requests fire during the redeem window (decides M1)
- [ ] The `hung` scenario documents the stock behavior at a >12 s exchange delay

**Verify:** `node compose/oidc-dev/verify.mjs m1-seeded` output + `BASELINE.md` diff.

**Steps:**

- [ ] **Step 1:** run all scenarios pre-fix; save ndjson outputs; write `BASELINE.md` with per-scenario results and the mechanism attribution.
- [ ] **Step 2:** compare M1 evidence against §7.5's design premise (stale-token requests during pending) — record confirmed/refuted.
- [ ] **Step 3:** Commit (`docs(harness): pre-fix baseline — mechanisms reproduced`).

### Task 6: `ui/src/lib/redeem-gate.ts` — the settlement gate module

**Goal:** The gate state machine + MutationCache hooks + watchdog + evidence flag, exactly per spec §7.1/§7.3.

**Files:**
- Create: `ui/src/lib/redeem-gate.ts`

**Acceptance Criteria:**
- [ ] `cd ui && yarn build` (tsc) passes with the module imported by nothing yet (type-level check only)
- [ ] Module exports: `createRedeemGateHooks()`, `initRedeemGate(client)`, `useRedeemGateOpen()`, `useRedeemState()`, `readRedeemFlag()`, `consumeRedeemFlag()`

**Verify:** `cd ui && yarn build` → clean.

**Steps:**

- [ ] **Step 1: write the module** — complete implementation:

```ts
import { useSyncExternalStore } from "react";
import type { MutationCacheConfig, QueryClient } from "@tanstack/react-query";

// Redeem lifecycle (spec §7.1). "idle" means OPEN everywhere: only a document
// that itself arms the redeem mutation can leave idle, so every gate keyed on
// `!== "pending"` behaves exactly like today on normal page loads.
export type RedeemState = "idle" | "pending" | "settled-ok" | "settled-failed";

const REDEEM_KEY = "ExchangeForJwt";
const WATCHDOG_MS = 12_000;
const FLAG_TTL_MS = 15_000;
const FLAG_KEY = "komodo-redeem";
const TOKENS_KEY = "mogh-auth-tokens-v1"; // mogh_auth_client 1.7.1 tokens.js:5

let state: RedeemState = "idle";
let watchdog: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const isExchange = (m: { options?: { mutationKey?: unknown[] } } | undefined) =>
  m?.options?.mutationKey?.[0] === REDEEM_KEY;

function setState(next: RedeemState) {
  if (state === next) return;
  state = next;
  if (state !== "pending" && watchdog !== undefined) {
    clearTimeout(watchdog);
    watchdog = undefined;
  }
  listeners.forEach((l) => l());
}

// Exception-free helper: mutation.cjs awaits config onSuccess BEFORE mogh_ui's
// token write with no per-hook guard (only the error-path hooks are wrapped) —
// a throw here converts a 200 exchange into the failure path (manufactured M2).
function safe<T>(fn: () => T, label: string): T | undefined {
  try {
    return fn();
  } catch (e) {
    console.error(`redeem-gate: ${label} failed (ignored)`, e);
    return undefined;
  }
}

const sessionStorageOk =
  typeof window !== "undefined" &&
  safe(() => {
    const k = `${FLAG_KEY}-probe`;
    window.sessionStorage.setItem(k, "1");
    window.sessionStorage.removeItem(k);
    return true;
  }, "sessionStorage probe") === true;

// Single evidence flag (spec §7.3): never carries the raw jwt.
type RedeemFlag = { t: number; phase: "ok" | "drop" };

function writeFlag(phase: RedeemFlag["phase"]) {
  if (!sessionStorageOk) return;
  safe(
    () => window.sessionStorage.setItem(FLAG_KEY, JSON.stringify({ t: Date.now(), phase })),
    "flag write",
  );
}

export function readRedeemFlag(): RedeemFlag | undefined {
  if (!sessionStorageOk) return undefined;
  return safe(() => {
    const raw = window.sessionStorage.getItem(FLAG_KEY);
    return raw ? (JSON.parse(raw) as RedeemFlag) : undefined;
  }, "flag read");
}

export function consumeRedeemFlag() {
  if (!sessionStorageOk) return;
  safe(() => window.sessionStorage.removeItem(FLAG_KEY), "flag clear");
}

export function flagFresh(flag: RedeemFlag | undefined): boolean {
  return !!flag && flag.phase === "ok" && Date.now() - flag.t < FLAG_TTL_MS;
}

/** True unless a redeem mutation is in flight. The one gate predicate. */
export function useRedeemGateOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state !== "pending",
    () => true,
  );
}

export function useRedeemState(): RedeemState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => "idle" as RedeemState,
  );
}

/** Cache-config hooks: synchronous inside execute, before mogh_ui's handlers. */
export function createRedeemGateHooks(): MutationCacheConfig {
  return {
    onMutate: (_variables, mutation) => {
      if (!isExchange(mutation)) return;
      setState("pending");
      safe(() => {
        if (watchdog === undefined) {
          watchdog = setTimeout(() => {
            watchdog = undefined;
            // Fail-safe convergence; a late success still recovers via
            // mogh_ui's own handler + the login-page redirect (§7.7).
            setState("settled-failed");
          }, WATCHDOG_MS);
        }
      }, "watchdog arm");
    },
    onSuccess: (data, _variables, _context, mutation) => {
      if (!isExchange(mutation)) return;
      // Pre-navigation evidence: exchange 200'd; mogh_ui's write+reload next.
      writeFlag("ok");
    },
  };
}

/** Settlement subscription; lives for the page's lifetime. */
export function initRedeemGate(client: QueryClient) {
  client.getMutationCache().subscribe((event) => {
    if (event.type !== "updated" || !isExchange(event.mutation)) return;
    const action = (event.action as { type?: string } | undefined)?.type;
    if (action === "success") {
      // Fires AFTER mogh_ui's onSuccess. M2 check: did storage gain the jwt?
      const jwt = (event.mutation.state.data as { jwt?: string } | undefined)?.jwt;
      let stored = false;
      if (jwt) {
        stored =
          safe(() => {
            const raw = localStorage.getItem(TOKENS_KEY);
            const parsed = raw ? (JSON.parse(raw) as { tokens?: Array<{ jwt: string }> }) : undefined;
            return parsed?.tokens?.some((t) => t.jwt === jwt) === true;
          }, "M2 storage read") === true;
      }
      writeFlag(jwt && !stored ? "drop" : "ok"); // refresh t: late-success TTL runs from here
      setState("settled-ok");
    } else if (action === "error") {
      setState("settled-failed");
    }
  });
}
```

- [ ] **Step 2:** `cd ui && yarn build` → clean (module unused but type-checked).
- [ ] **Step 3:** Commit (`feat(ui): redeem settlement gate — watchdog, hooks, evidence flag`).

### Task 7: `main.tsx` — construct the MutationCache + init

**Goal:** Komodo owns the cache config; subscription attached once at module scope.

**Files:**
- Modify: `ui/src/main.tsx:27-31` (QueryClient construction; `setAuthUrl` stays)

**Acceptance Criteria:**
- [ ] `new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } }, mutationCache: new MutationCache(createRedeemGateHooks()) })` — note: query `retry: false` preserved verbatim; `mutations.retry: false` is the pinned default already (mutation.cjs:82), stated for clarity
- [ ] `initRedeemGate(client)` called once before `ReactDOM.createRoot(...)`

**Verify:** `cd ui && yarn build` → clean; harness `success` scenario still boots the app.

**Steps:**

- [ ] **Step 1: edit `main.tsx`**

```tsx
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRedeemGateHooks, initRedeemGate } from "@/lib/redeem-gate";
// …existing imports…

const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
  mutationCache: new MutationCache(createRedeemGateHooks()),
});

setAuthUrl(KOMODO_BASE_URL + "/auth");
initRedeemGate(client); // module-scope, once — StrictMode-immune (no effects)
```

- [ ] **Step 2:** build + commit (`feat(ui): wire redeem gate into the QueryClient`).

### Task 8: `router.tsx` — pending gate + in-document settled-failed path

**Goal:** LoadingScreen only while pending; settled-failed converges in-document (§7.2).

**Files:**
- Modify: `ui/src/router.tsx:45-56` (Router head), add a `useEffect`

**Acceptance Criteria:**
- [ ] Gate reads settlement state only — the `jwt_redeem_ready` URL bit no longer drives the LoadingScreen
- [ ] Settled-failed: `LOGIN_TOKENS.remove_all()` → strip `redeem_ready|totp|passkey` via `history.replaceState` → Mantine notification → falls through to `RequireAuth` (→ `/login?backto=…`)

**Verify:** `yarn build`; harness `hung` scenario shows converged spinner; failure scenario shows the notification (screenshot assert optional).

**Steps:**

- [ ] **Step 1: replace the Router head**

```tsx
import { useEffect } from "react";
import { notifications } from "@mantine/notifications";
import { MoghAuth } from "komodo_client";
import { useRedeemState } from "@/lib/redeem-gate";
// …

export const Router = () => {
  // mogh_ui's useAuthState fires the redeem mutation synchronously in its body
  // during THIS render — the config onMutate flips the gate to "pending"
  // before the snapshot read below, so render #1 is already the LoadingScreen.
  // The jwt_redeem_ready URL bit is deliberately unused: after location.replace
  // is initiated, location.search is stale until the new document commits.
  const { passkey_pending, totp } = useAuthState();
  const redeemState = useRedeemState();

  useEffect(() => {
    if (redeemState !== "settled-failed") return;
    MoghAuth.LOGIN_TOKENS.remove_all(); // storage hygiene; poller control is §7.5's gate
    const url = new URL(window.location.href);
    for (const p of ["redeem_ready", "totp", "passkey"]) url.searchParams.delete(p);
    window.history.replaceState(null, "", url.pathname + url.search);
    notifications.show({
      title: "Login didn't complete",
      message: "Returned to the login page.",
      color: "red",
    });
  }, [redeemState]);

  if (redeemState === "pending") {
    return <LoadingScreen />;
  }

  if (passkey_pending || totp) {
    return <Login passkeyIsPending={passkey_pending} totpIsPending={totp} />;
  }
  // …unchanged Routes…
```

- [ ] **Step 2:** build; commit (`feat(ui): in-document redeem failure path + pending-only gate`).

### Task 9: `socket.tsx` + `hooks.ts` — provider gating, `useUser` config, §7.6 drive-by

**Goal:** Provider reads + websocket connect gated by `useRedeemGateOpen() && hasJwt`; `useRead`'s spread reordered.

**Files:**
- Modify: `ui/src/lib/hooks.ts:50-68` (useUser config param), `:99-104` (useRead spread order)
- Modify: `ui/src/lib/socket.tsx:58-76` (gating)

**Acceptance Criteria:**
- [ ] `useUser(config?)` composes `enabled: (config?.enabled ?? true) && hasJwt`
- [ ] `useRead` computes `enabled` AFTER spreading config (composes, never overridden)
- [ ] socket reads use `enabled: gateOpen`; connect effect unchanged (keys on `user && disable_reconnect !== undefined`, which the read gating already defers)
- [ ] On normal loads (`idle`) behavior is byte-identical to pre-fix

**Verify:** `yarn build`; harness `success` (ws connected ≤ 5 s) + `m1-seeded` (no stale-token requests during pending post-fix).

**Steps:**

- [ ] **Step 1: `hooks.ts` useUser**

```ts
export function useUser(config?: { enabled?: boolean }) {
  const userReset = useUserReset();
  const hasJwt = !!MoghAuth.LOGIN_TOKENS.jwt();

  const query = useQuery({
    queryKey: ["GetUser"],
    queryFn: () => komodo_client().getUser(),
    refetchInterval: 30_000,
    ...config,
    // Composed AFTER the spread (§7.6 rule): caller intent composes with the
    // jwt gate instead of replacing it.
    enabled: (config?.enabled ?? true) && hasJwt,
  });
  // …rest unchanged…
```

- [ ] **Step 2: `hooks.ts` useRead reorder (§7.6 drive-by)**

```ts
  const hasJwt = !!MoghAuth.LOGIN_TOKENS.jwt();
  return useQuery({
    queryKey: [type, params],
    queryFn: () => komodo_client().read<T, R>(type, params),
    ...config,
    // Composed AFTER the spread: an explicit caller `enabled` (including
    // `undefined`) used to replace the jwt gate wholesale — 46 sites.
    enabled: hasJwt && config?.enabled !== false,
  });
```

- [ ] **Step 3: `socket.tsx`**

```tsx
import { useRedeemGateOpen } from "@/lib/redeem-gate";
// …inside WebsocketProvider…
  const gateOpen = useRedeemGateOpen();
  const user = useUser({ enabled: gateOpen }).data;
  const disable_reconnect = useRead("GetCoreInfo", {}, { enabled: gateOpen }).data;
```

- [ ] **Step 4:** build; commit (`feat(ui): gate provider reads behind pending; compose enabled with jwt gate`).

### Task 10: `login.tsx` — §7.7 one-shot redirect + M2 drop message

**Goal:** Late-success landing fix + surfaced silent-drop.

**Files:**
- Modify: `ui/src/pages/login.tsx`

**Acceptance Criteria:**
- [ ] Fresh `phase:"ok"` flag (< 15 s) + jwt present in store → `navigate(backto ?? "/", { replace: true })`, flag cleared
- [ ] `phase:"drop"` flag → notification "Login succeeded but the session could not be stored", flag cleared
- [ ] No flag / stale flag → behavior identical to today

**Verify:** `yarn build`; harness `hung` post-fix lands on `backto ?? "/"`.

**Steps:**

- [ ] **Step 1: extend `login.tsx`**

```tsx
import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { notifications } from "@mantine/notifications";
import { LoginPage } from "mogh_ui";
import { useUserInvalidate } from "@/lib/hooks";
import { consumeRedeemFlag, flagFresh, readRedeemFlag } from "@/lib/redeem-gate";

export default function Login(props: {
  passkeyIsPending?: boolean;
  totpIsPending?: boolean;
}) {
  const userInvalidate = useUserInvalidate();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  useEffect(() => {
    const flag = readRedeemFlag();
    if (!flag) return;
    if (flag.phase === "drop") {
      consumeRedeemFlag();
      notifications.show({
        title: "Login succeeded but the session could not be stored",
        message: "Please log in again.",
        color: "red",
      });
      return;
    }
    if (!flagFresh(flag)) return; // stale: ignore, leave for TTL-free cleanup
    // jwt presence, decode-free: any entry in the mogh-auth store (§7.3 schema).
    let hasJwt = false;
    try {
      const raw = localStorage.getItem("mogh-auth-tokens-v1");
      const parsed = raw ? JSON.parse(raw) : undefined;
      hasJwt = Array.isArray(parsed?.tokens) && parsed.tokens.length > 0;
    } catch {
      hasJwt = false;
    }
    if (hasJwt) {
      consumeRedeemFlag();
      navigate(params.get("backto") ?? "/", { replace: true });
    }
  }, []);

  return (
    <LoginPage
      {...props}
      appName="KOMODO"
      iconLink="/mogh-512x512.png"
      iconLinkAlt="moghtech"
      exampleConfigLink="https://github.com/moghtech/komodo/blob/main/config/core.config.toml"
      onLogin={userInvalidate}
    />
  );
}
```

- [ ] **Step 2:** build; commit (`feat(ui): late-success login redirect + silent-drop surfacing`).

### Task 11: Full suite green + non-regressions + PR readiness

**Goal:** Every harness scenario green post-fix; build clean; upstream issue drafts materialized from `BASELINE.md`.

**Files:**
- Modify: `compose/oidc-dev/BASELINE.md` (post-fix columns)

**Acceptance Criteria:**
- [ ] `success`, `latency`, `m1-seeded`, `hung`, `isolation` all `SCENARIO … PASS` post-fix
- [ ] Zero-residual + ws-alive + gate-isolation assertions pass
- [ ] `cd ui && yarn build` clean; `git diff origin/main --stat` touches only `ui/src`, `compose/oidc-dev*`
- [ ] Upstream issue drafts (mogh_ui silent drop; limiter keying; forward-auth interplay if M3) exist as text in `BASELINE.md`, each citing harness evidence

**Verify:** the suite run + `git diff origin/main --stat`.

**Steps:**

- [ ] **Step 1:** rebuild the UI override image; run all five scenarios; attach results to `BASELINE.md` (pre vs post columns).
- [ ] **Step 2:** diff-scope check: `hug diff origin/main --stat` — only `ui/src/**` and `compose/oidc-dev*` (workflow docs `docs/superpowers/**` are stripped before final review per spec §10; note in PR body).
- [ ] **Step 3:** draft the upstream issues text into `BASELINE.md`.
- [ ] **Step 4:** Commit (`docs(harness): post-fix results + upstream issue drafts`).

---

## Self-review notes

- Spec coverage: §6 → Tasks 1–5; §7.1 → Task 6/7; §7.2 → Task 8; §7.3 → Task 6 (flag contract) + Task 10 (drop consumer); §7.4 → Task 7 (the same `onSuccess` write is the recorder); §7.5 → Task 9; §7.6 → Task 9 Step 2; §7.7 → Task 10; §8 matrix → Task 4 assertions; §9 → Task 11; §11 criteria → Tasks 4/5/11.
- Type consistency: `RedeemState`, `useRedeemGateOpen`, `createRedeemGateHooks`, `initRedeemGate`, `readRedeemFlag`/`consumeRedeemFlag`/`flagFresh` named identically across Tasks 6–10.
- Known deviation from writing-plans' TDD default: no unit-test framework (spec §3); red-green lives at harness level (Task 5 red → Task 11 green).
