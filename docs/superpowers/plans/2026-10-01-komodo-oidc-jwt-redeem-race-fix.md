# Komodo OIDC JWT Redeem Race Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix moghtech/komodo#1665 — after a successful OIDC `ExchangeForJwt`, the UI never sends the returned JWT — via a settlement gate in komodo's `ui/src`, verified by a docker harness that reproduces the failure before the fix lands.

**Architecture:** Embrace-the-reload posture (spec §7, post-roast round 4): mogh_ui 1.2.7's success path reloads the document and no komodo hook can precede that navigation, so komodo (a) arms a watchdog + evidence flag from a module-scope `MutationCache` config (synchronous, inside `execute`), (b) keeps app queries + the update websocket behind a `pending`-only gate, (c) converges definite failures in-document (`remove_all` + `history.replaceState` + notification), and (d) one-shot-redirects a late success off `/login`. Phase 1 (Tasks 1–5) builds `compose/oidc-dev` and MUST name the confirmed mechanism before any §7 code (Tasks 6–10) lands.

**Tech Stack:** React 19 + TypeScript (komodo `ui/`), @tanstack/react-query 5.102.4 (pinned), mogh_ui 1.2.7 / mogh_auth_client 1.7.1 (pinned — no dep changes), docker compose (mongo + digest-pinned komodo-core + node-oidc-provider mock + Caddy), Playwright (headless chromium, dev-only, host-installed for the harness driver).

**Testing note (deviation from classic TDD):** komodo's `ui/` has no unit-test framework and the spec forbids adding one (§3). Per-task verification is `yarn build` (tsc, strict) for code tasks; behavioral verification is the Task 4 harness suite. TDD's red-green shape is preserved at the system level: Task 5 runs the suite against pre-fix code (red on the fix assertions), Tasks 6–10 make it green.

**Spec:** `docs/superpowers/specs/2026-10-01-komodo-oidc-login-jwt-redeem-race-fix-1665-design.md` (authoritative; section refs below).

---

### Task 1: Harness skeleton — compose, mongo, digest-pinned core

**Goal:** `docker compose -f compose/oidc-dev.compose.yaml up` boots mongo + komodo-core (branch-built UI via the core-override image) and core reports healthy on the proxy-less path.

**Files:**
- Create: `compose/oidc-dev.compose.yaml`
- Create: `compose/oidc-dev/core-ui.Dockerfile`
- Create: `compose/oidc-dev/README.md`

**Acceptance Criteria:**
- [ ] `docker compose -f compose/oidc-dev.compose.yaml up -d mongo core` ends with both containers running
- [ ] `curl -s -o /dev/null -w '%{http_code}' http://localhost:9120` → `200` (core serves the branch-built UI directly)
- [ ] The core base image is digest-pinned; the served UI comes from `core-ui.Dockerfile`'s build stage (spec §6.3)

**Verify:** `docker compose -f compose/oidc-dev.compose.yaml ps --format '{{.Service}} {{.Status}}'` → both `Up`.

**Steps:**

- [ ] **Step 1: Pin the core image digest**

```sh
docker buildx imagetools inspect ghcr.io/moghtech/komodo-core:v2.3.3 | grep -i digest | head -1
```
Record the manifest digest (`sha256:…`) — substitute it for `PINNED_DIGEST` in Step 2.

- [ ] **Step 2: Write `compose/oidc-dev/core-ui.Dockerfile`**

```dockerfile
# Branch UI served by the digest-pinned core image (spec §6.3).
# Stage 1 mirrors ui/Dockerfile's builder stage; stage 2 is production core.
ARG CORE_IMAGE
FROM node:22.12-alpine AS builder
WORKDIR /builder
COPY ./ui ./ui
COPY ./client/core/ts ./client
ARG VITE_KOMODO_HOST=""
ENV VITE_KOMODO_HOST=$VITE_KOMODO_HOST
RUN cd client && yarn && yarn build && yarn link
RUN cd ui && yarn link komodo_client && yarn && yarn build

FROM ${CORE_IMAGE}
COPY --from=builder /builder/ui/dist /app/ui
```

- [ ] **Step 3: Write `compose/oidc-dev.compose.yaml`**

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
    # Branch-built UI served by core exactly like production (spec §6.3):
    # stage 1 = ui/Dockerfile's builder stage on this branch; stage 2 = the
    # digest-pinned core image with the dist copied to /app/ui.
    # Digest pinned in compose/oidc-dev/.env (KOMODO_CORE_IMAGE) — see README step 1.
    build:
      context: ..
      dockerfile: compose/oidc-dev/core-ui.Dockerfile
      args:
        CORE_IMAGE: ${KOMODO_CORE_IMAGE}
    image: komodo-oidc-dev-core
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

- [ ] **Step 4: Write `compose/oidc-dev/.env`** (gitignored content pattern — check `git check-ignore`; if `.env` files are not ignored in this repo, name it `.env.example` + copy at runtime; the docker `--env-file` flag takes any name)

```sh
# Pin the digest you recorded in Step 1:
KOMODO_CORE_IMAGE=ghcr.io/moghtech/komodo-core@sha256:PINNED_DIGEST
```

- [ ] **Step 5: Write `compose/oidc-dev/core-config.toml`** (minimal file config; field names from `config/core.config.toml` — verify the `oidc_*` block against that file when wiring Task 3)

```toml
# Harness core config. Never use these secrets outside compose/oidc-dev.
host = "https://komodo.oidctest.localhost"
local_auth = true
oidc_enabled = false
oidc_auto_redirect = false
jwt_secret = "oidc-dev-jwt-secret-not-for-production"
```

- [ ] **Step 6: Write `compose/oidc-dev/README.md`** — run instructions (the `docker compose` line from the yaml header), the digest-pinning step, and the pin: `node-oidc-provider` version `11.10.1` (the version this harness's mock is written against; bump only with a re-run of the full suite). Include the cookie caveat: the mock sets its session cookie on the parent domain `oidctest.localhost` (required for forward_auth to see it); if a test browser rejects `Domain=` attributes under `.localhost` (PSL edge), switch the harness hosts to a `*.oidctest.test` style name + `/etc/hosts` entries rather than dropping the domain.

- [ ] **Step 7: Boot and verify**

```sh
docker compose -f compose/oidc-dev.compose.yaml --env-file compose/oidc-dev/.env up -d --build mongo core
docker compose -f compose/oidc-dev.compose.yaml ps --format '{{.Service}} {{.Status}}'
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9120
```
Expected: both `Up`; `200`.

- [ ] **Step 8: Commit** — `hug a compose/oidc-dev.compose.yaml compose/oidc-dev/core-ui.Dockerfile compose/oidc-dev/README.md compose/oidc-dev/core-config.toml` then `hug c -F - <<'EOF' … feat(harness): oidc-dev skeleton — digest-pinned core + mongo … EOF` (do NOT commit `compose/oidc-dev/.env`).

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
  // Session cookie MUST be a parent-domain cookie (C-001): host-only for
  // portal.oidctest.localhost would never reach komodo.oidctest.localhost, so
  // Caddy's forward_auth subrequest would 401 EVERY komodo request, including
  // /auth/oidc/callback — no login could ever complete. This mirrors Authelia,
  // which sets its cookie on the shared parent domain.
  cookies: { long: { domain: "oidctest.localhost" } },
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
      // Honest failures (C-011): lookup ERROR is 503 (provider/API problem),
      // absence of session is 401. Caddy's access log then discriminates them.
      // NOTE: verify provider.Session.get's expected argument shape against the
      // pinned v11 docs BEFORE relying on it — oidc-provider documents Koa
      // contexts; if the raw IncomingMessage shape fails, mount /verify through
      // the provider's Koa app instead of a bare http handler.
      let session;
      try {
        session = await provider.Session.get(req);
      } catch (e) {
        console.error("verify: session lookup failed", e);
        return res.writeHead(503).end("lookup error");
      }
      if (session && (await session.userId())) return res.writeHead(200).end("ok");
      console.warn("verify: no session for request");
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
(Build context is `compose/oidc-dev` — see Task 2 Step 5; the Dockerfile's `COPY oidc-mock/...` paths resolve from there.)

- [ ] **Step 5: add the service to `compose/oidc-dev.compose.yaml`**

```yaml
  oidc-mock:
    build:
      context: ./oidc-dev
      dockerfile: oidc-mock/Dockerfile
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
- [ ] `caddy validate` passes: `docker compose run --rm --entrypoint caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
- [ ] Without a session, `https://komodo.oidctest.localhost` → **redirect to the portal** (a bare 401 FAILS this AC — C-001: it would mean the forward-auth gate is misconfigured, not "protecting")
- [ ] After a portal login, `https://komodo.oidctest.localhost` reaches the Komodo UI (this proves the mock's session cookie actually reaches the komodo host — parent-domain cookie works)
- [ ] `compose/oidc-dev/access.log` contains JSON entries with `request.headers` keys
- [ ] Manual OIDC login ends at `/?redeem_ready=true` → Komodo UI. If it instead loops, check the access log FIRST for 503s on `/verify` (a lookup error must not be recorded as a reproduced M3)

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
	forward_auth oidc-mock:3344 {
		uri /verify
	}
	# LATENCY KNOB (spec §6): /auth/login/* goes through the delay sidecar;
	# everything else straight to core. DELAY_AUTH_MS must stay < the 12 s
	# watchdog (§7.1); the dedicated past-watchdog row uses 15000.
	route {
		@auth path /auth/login/*
		handle @auth { reverse_proxy delay:9999 }
		handle { reverse_proxy core:9120 }
	}
}
```

The knob is the one-file Node delay proxy below (`compose/oidc-dev/delay.mjs`): Caddy
routes `/auth/login/*` to `delay:9999`, which awaits a real `setTimeout(DELAY_AUTH_MS)`
before dispatching to `core:9120`. (`ClientRequest.setTimeout` is NOT used — it only arms
a socket-inactivity event with no listener; it delays nothing.)

```js
// compose/oidc-dev/delay.mjs — adds DELAY_AUTH_MS to /auth/login/* only.
import http from "node:http";
const DELAY = parseInt(process.env.DELAY_AUTH_MS ?? "0", 10);
http.createServer(async (req, res) => {
  if (req.url?.startsWith("/auth/login/") && DELAY > 0) {
    await new Promise((r) => setTimeout(r, DELAY)); // the ONLY working delay: await before dispatch
  }
  const upstream = http.request(
    { host: "core", port: 9120, path: req.url, method: req.method, headers: req.headers },
    (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); },
  );
  req.pipe(upstream);
}).listen(9999);
```

Validate the Caddyfile as a Task 3 acceptance step: `docker compose run --rm --entrypoint caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`.

- [ ] **Step 2: add `caddy` + `delay` services to the compose file** — and `touch compose/oidc-dev/access.log` BEFORE the first `up`: Docker pre-creates a **directory** (not a file) for a bind-mount source that does not exist, which makes Caddy's file-logger fail; the empty file must exist first.

```yaml
  delay:
    # No build at all: delay.mjs imports only node:http (C-015 — reusing the
    # mock Dockerfile here fails: its COPY paths assume context ./oidc-dev).
    image: node:22.12-alpine
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
- [ ] Every scenario prints a final `SCENARIO <name> <PASS|FAIL>` line and writes per-request rows (url, authorization present, status, ts) to `compose/oidc-dev/out/<scenario>.ndjson`, including console-shim TOKENS rows
- [ ] `latency`/`hung` assert observed exchange round-trip ≥ `DELAY_AUTH_MS` (a no-op knob fails visibly)

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
// Baseline at process start (C-020): the file is persistent across runs, so a
// fresh process must never re-read prior runs' entries — otherwise checks pass
// on stale evidence. Truncating between scenarios (README) is belt-and-braces.
const LOG_PATH = new URL("./access.log", import.meta.url).pathname;
let logOffset = statSync(LOG_PATH).size;
function pollLog() {
  const size = statSync(LOG_PATH).size;
  if (size < logOffset) logOffset = 0; // truncated/rotated mid-run
  const fd = openSync(LOG_PATH, "r");
  const buf = Buffer.alloc(size - logOffset);
  readSync(fd, buf, 0, buf.length, logOffset);
  logOffset = size;
  return buf.toString("utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; } // torn write at a poll boundary
  });
}

const APP_FETCH_ORIGINS = ["https://komodo.oidctest.localhost"];
const isAppFetch = (e) =>
  APP_FETCH_ORIGINS.includes(`https://${e.request.host}`) &&
  !e.request.headers?.["Sec-Fetch-Dest"]?.includes("document") &&
  !e.request.uri?.endsWith(".js") && !e.request.uri?.endsWith(".css");
const unauthOrFail = (e) => {
  const auth = e.request.headers?.Authorization ?? e.request.headers?.authorization;
  const status = e.resp_headers?.status ? parseInt(e.resp_headers.status) : e.status;
  // §6 exclusion list FIRST: /auth/login/* without a header is auth-surface
  // discovery by design (GetLoginOptions, a consumed-session exchange 401) and
  // is exempt from BOTH disjuncts below.
  if (!auth && e.request.uri?.startsWith("/auth/login/")) return false;
  return !auth || status === 401 || status === 403;
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

async function drive(browser, { seedStale = false, attachShimFn } = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  if (seedStale) await seedStaleToken(context);
  if (attachShimFn) await attachShimFn(context); // BEFORE any navigation (O-001): the
  // exchange document's add_and_change transition is the M2-critical one to log.
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto("https://komodo.oidctest.localhost");
  // The pinned mogh_ui@1.2.7 LoginPage renders NO OIDC button (dist-verified);
  // its only OIDC entry is the oidc_auto_redirect effect, which the harness
  // pins FALSE (M6 discrimination). Start the identical core-side flow by
  // direct navigation — mogh_auth_client's externalLogin builds exactly this
  // URL (dist src/lib.ts: `${AUTH_URL}/oidc/login?redirect=...`).
  await page.goto("https://komodo.oidctest.localhost/auth/oidc/login?redirect=%2F");
  await page.waitForURL(/portal\.oidctest\.localhost/, { timeout: 20_000 }); // fail loudly
  await page.getByRole("button", { name: /sign in|continue/i }).first().click().catch((e) => {
    throw new Error("drive: portal sign-in control not found — check the mock's dev interaction"); 
  });
  await page.waitForURL(/komodo\.oidctest\.localhost/, { timeout: 20_000 });
  return { context, page, t0 };
}

// --- scenario assertions (spec §6) ---
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// Caddy's JSON log ts is a float in EPOCH SECONDS (C-017) — never Date.parse it.
const logSec = (e) => {
  const v = typeof e.ts === "number" ? e.ts : Number(e.ts);
  if (!Number.isFinite(v)) throw new Error("non-finite log timestamp — check field/unit");
  return v;
};
check("exchange 200 observed", (log) => log.some((e) => e.request.uri.includes("/auth/login/ExchangeForJwt") && (e.resp_headers?.status ?? e.status) === 200));
check("authenticated app follow-up <= 3s after exchange", (log) => {
  const exch = log.filter((e) => e.request.uri.includes("ExchangeForJwt")).at(-1);
  if (!exch) return false;
  return log.some((e) =>
    logSec(e) - logSec(exch) <= 3.0 // seconds, log's own unit
    && (e.request.headers?.Authorization ?? e.request.headers?.authorization)
    && (e.resp_headers?.status ?? e.status) === 200);
});
check("success-row unauth-or-401 window total <= 4", () => { throw new Error("check not implemented"); });
check("update websocket connected (positive, two signals)", (log, { page }) => {
  // C-019: no default-to-success. The log row must carry status 101 explicitly,
  // AND the browser side must show liveness (console-shim or ws state).
  const row = log.find((e) => e.request.uri.includes("/ws/update"));
  if (row?.status !== 101 && row?.resp_headers?.status !== "101") return false;
  // Step 2 fills the browser-side liveness marker here (console-shim message
  // from the socket's on_login, or the ws connected state). Fail closed until then:
  return false;
});
check("zero residual after settled-failure (excl /auth/login/*)", () => { throw new Error("check not implemented"); });
// … scenario composition below …

const log0 = [];
setInterval(() => { for (const e of pollLog()) { record(e); log0.push(e); } }, 250).unref();

// Console shim (spec §6): log localStorage token-store transitions with ts,
// collected via page.on('console') into the same ndjson.
async function attachShim(context, rows) {
  await context.addInitScript(`
    const KEY = "mogh-auth-tokens-v1";
    let prev = localStorage.getItem(KEY);
    const report = (v) => console.debug("TOKENS", Date.now(), JSON.stringify(v));
    report(prev);
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (k, v) => {
      if (k === KEY && v !== prev) { prev = v; report(v); }
      return orig(k, v);
    };
  `);
}

const browser = await chromium.launch();
const { context, page, t0 } = await drive(browser, {
  seedStale: SCEN === "m1-seeded",
  attachShimFn: (ctx) => attachShim(ctx, rows), // pre-navigation (O-001)
});
page.on("console", (msg) => {
  if (msg.text()?.startsWith("TOKENS")) rows.push({ ts: Date.now(), kind: "tokens", detail: msg.text() });
});
// m2-forced: rewrite the exchange response with a structurally valid sub-less
// jwt -> add_and_change silently drops it (tokens.ts:21-22) while the
// subscription still sees a jwt -> the M2 detection must fire.
if (SCEN === "m2-forced") {
  const sublessJwt = "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ exp: 9999999999 })).toString("base64url") + ".sig";
  await context.route("**/auth/login/ExchangeForJwt", async (route) => {
    const resp = await route.fetch();
    const body = await resp.json().catch(() => ({}));
    if (body?.jwt) body.jwt = sublessJwt;
    await route.fulfill({ response: resp, json: body });
  });
}
// Failure rows must OBSERVE the 60 s zero-residual window they assert (C-018):
// settle, then wait it out. The stale-token feed resumes at the next 30 s poll
// tick, which a short-lived driver would never see.
if (["hung", "exchange-error"].includes(SCEN)) {
  await page.waitForTimeout(SCEN === "hung" ? 20_000 : 8_000); // settle
  await page.waitForTimeout(60_000); // the asserted residual window itself
} else {
  await page.waitForTimeout(8_000);
}
// Delay assertions (C-005): a no-op knob must fail visibly. The observed
// exchange round-trip (Caddy log: request start -> response) must be >= DELAY.
// The hung row additionally asserts the settlement path TAKEN (converged via
// the watchdog: LoadingScreen then /login), not merely the final URL.

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

- [ ] **Step 3: scenario composition** — `success` (plain), `latency` (`DELAY_AUTH_MS=2000`; asserts observed exchange round-trip ≥ 2000 ms from log timestamps), `m1-seeded` (Step `seedStaleToken`), `m2-forced` (route-rewritten sub-less exchange response; asserts the drop flag is set and the login page surfaces "session could not be stored" post-fix), `exchange-error` (complete a portal login, then replay `/?redeem_ready=true` with the consumed session → exchange 4xx; asserts converged failure path pre-fix eternal-spinner), `hung` (`DELAY_AUTH_MS=15000` — past the watchdog; asserts the settlement path TAKEN — a LoadingScreen must be observed BEFORE the `/login` landing (spinner selector from mogh_ui's LoadingScreen), otherwise the row cannot distinguish watchdog-settled from reload-landed — then §7.7 landing post-fix), `isolation` (post-login `page.evaluate(fetch("/execute/StartDeployment", {method:"POST"}))` → expects 4xx and asserts NO LoadingScreen flip and no reload to `/login` within 2 s).

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
import { MoghAuth } from "komodo_client";

// Redeem lifecycle (spec §7.1). "idle" means OPEN everywhere: only a document
// that itself arms the redeem mutation can leave idle, so every gate keyed on
// `!== "pending"` behaves exactly like today on normal page loads.
// Delivery fact (spec §4): cache listeners run synchronously inside the
// dispatch's task — a render-phase dispatch notifies zero effect-scoped
// subscribers, deterministically. Arming uses the config hooks, which run
// inside execute regardless.
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
  if (next === "settled-failed") {
    // Hygiene runs HERE — synchronously, before the flip can trigger any
    // React render. Doing this in Router's effect would run after the parent
    // provider's flip render, whose hasJwt would still read stale-true, and
    // one stale-token request would escape after settlement.
    safe(() => MoghAuth.LOGIN_TOKENS.remove_all(), "remove_all");
  }
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
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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
    // NOTE: token hygiene (remove_all) does NOT live here — it runs in the
    // settlement listener (redeem-gate.ts), synchronously before this render.
    // This effect is UI convergence only: URL strip + notification.
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
    // jwt gate instead of replacing it (function form composed too).
    enabled:
      typeof config?.enabled === "function"
        ? (q) => (config.enabled(q) !== false) && hasJwt
        : (config?.enabled ?? true) && hasJwt,
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
    // Function-valued enabled (query-core's legal callback form) is composed,
    // not dropped: `!== false` would silently ignore it.
    enabled:
      typeof config?.enabled === "function"
        ? (q) => hasJwt && config.enabled(q) !== false
        : hasJwt && config?.enabled !== false,
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
    if (!flagFresh(flag)) return; // stale: ignored (§7.3 TTL); lingers harmlessly until tab close
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

- [ ] **Step 1:** rebuild the UI override image (`docker compose build core`); run all seven scenarios (`success`, `latency`, `m1-seeded`, `m2-forced`, `exchange-error`, `hung`, `isolation`); attach results to `BASELINE.md` (pre vs post columns) **plus the §8-row→scenario map table** in the harness README (each of §8's 8 rows mapped to the scenario id + assertion names that exercise it — §11's by-name criterion is checked against this map, not against the output format).
- [ ] **Step 2:** diff-scope check: `hug diff origin/main --stat` — only `ui/src/**` and `compose/oidc-dev*` (workflow docs `docs/superpowers/**` are stripped before final review per spec §10; note in PR body).
- [ ] **Step 3:** draft the upstream issues text into `BASELINE.md`.
- [ ] **Step 4:** Commit (`docs(harness): post-fix results + upstream issue drafts`).

---

## Self-review notes

- Spec coverage: §6 (incl. the core-ui override image, built by Task 1 and rebuilt in Task 11) → Tasks 1–5; §7.1 → Task 6/7 (incl. listener-side settled-failed hygiene); §7.2 → Task 8 (UI convergence only); §7.3 → Task 6 (flag contract) + Task 10 (drop consumer); §7.4 → Task 7 (the same `onSuccess` write is the recorder); §7.5 → Task 9 (single mechanism: read deferral; the connect effect inherits it); §7.6 → Task 9 Step 2; §7.7 → Task 10; §8 matrix → Task 4 assertions + the Task 11 row→scenario map; §9 → Task 11; §11 criteria → Tasks 4/5/11.
- Type consistency: `RedeemState`, `useRedeemGateOpen`, `createRedeemGateHooks`, `initRedeemGate`, `readRedeemFlag`/`consumeRedeemFlag`/`flagFresh` named identically across Tasks 6–10.
- Known deviation from writing-plans' TDD default: no unit-test framework (spec §3); red-green lives at harness level (Task 5 red → Task 11 green).
