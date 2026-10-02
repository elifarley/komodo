# OIDC redeem-race harness (moghtech/komodo#1665)

Repro harness for the OIDC-login JWT-redeem race: mongo + komodo-core serving the
**branch-built UI** from `/app/ui` exactly like production (spec §6.3). Later tasks
extend this project with the OIDC mock (`oidc-mock`), the Caddy proxy, and the
Playwright suite — this file's job is the skeleton: boot core + mongo, core healthy
on the proxy-less path.

## Run

Create `compose/oidc-dev/.env` first — it doesn't exist until Step 1 pins the digest.

```sh
docker compose -f compose/oidc-dev.compose.yaml --env-file compose/oidc-dev/.env up -d --build
docker compose -f compose/oidc-dev.compose.yaml ps
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9120   # expect 200
```

> On hosts where `docker` is a podman shim (no compose plugin), use the standalone
> binary against the podman socket: `docker-compose -f … --env-file … up -d --build`
> with `DOCKER_HOST=unix:///run/user/$UID/podman/podman.sock`.
>
> **Podman ≤ 3.4 bootstrap gotcha:** compose writes the project network's conflist
> with `cniVersion: 1.0.0`, which podman 3.4's CNI stack refuses to load
> ("CNI network not found" at container start). First `up` creates the network and
> fails; patch `~/.config/cni/net.d/komodo-oidc-dev_default.conflist`
> (`cniVersion` → `0.4.0`) once, then re-run `up`. Only needed on fresh network
> creation — `down` removes the network, so expect the patch again after it.

## Step 1 — pin the core image digest

`compose/oidc-dev/.env` holds `KOMODO_CORE_IMAGE`, the digest-pinned base image that
`core-ui.Dockerfile` builds on (`FROM ${CORE_IMAGE}`). It is gitignored — never commit it.

To re-pin (e.g. after a version bump), resolve the tag to a manifest digest:

```sh
# Note: the tag has NO leading "v" — ghcr.io/moghtech/komodo-core:2.3.3, not :v2.3.3.
docker buildx imagetools inspect ghcr.io/moghtech/komodo-core:2.3.3 | grep -i digest | head -1
```

No buildx? The registry API works the same way (anonymous pull on ghcr):

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:moghtech/komodo-core:pull" \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
  https://ghcr.io/v2/moghtech/komodo-core/manifests/2.3.3 \
  | grep -i docker-content-digest
```

Write the result into `compose/oidc-dev/.env`:

```sh
KOMODO_CORE_IMAGE=ghcr.io/moghtech/komodo-core@sha256:<digest>
```

Current pin (set 2026-10-01, tag `2.3.3`, OCI index digest):

```
sha256:bca73d0eee143066228fb9b80c38a5a2726e573ad2758f7aa92b5c91a8aef1c7
```

## Pinned dependencies

- **`node-oidc-provider` version `9.12.2`** — the latest release at harness time.
  The plan draft pinned "`11.10.1`", but that version does not exist on npm (no
  11.x line was ever published; latest = 9.12.2, previous = 6.31.1 — verified
  against the registry 2026-10-01). The API notes in `oidc-mock/index.mjs` are
  written against the 9.12.2 **source in `node_modules`**, not docs from memory.
  Bump only with a re-run of the full suite.

## Verify endpoint implementation note

`/verify` runs on a bare `node:http` server in front of the provider. Getting
`provider.Session.get` to work on a raw request took three source-verified
adaptations (all against `oidc-provider@9.12.2`, verified empirically after
boot — see acceptance evidence in the task):

1. **Pass `{ req, res }`, not the raw `req`.** `Session.get(ctx)` supports two
   shapes (`lib/models/session.js`): a Koa ctx with `ctx.oidc`, or any object
   with `.req`/`.res` — it calls `provider.createContext(ctx.req, ctx.res)`
   (Koa inherits `createContext`; `Provider extends Koa`). A bare
   `IncomingMessage` has neither shape, so `Session.get(req)` would throw →
   every request 503.
2. **Check `session.accountId`, there is no `userId()`.** The plan draft called
   `session.userId()`, which does not exist on the Session model — it would
   throw a TypeError into the 503 path on every call. `accountId` is the
   persisted login field.
3. **`provider.callback` is Koa's handler *factory*.** `Provider extends Koa`,
   so `provider.callback()` returns the `(req, res)` handler; calling
   `provider.callback(req, res)` would build a handler and drop it (requests
   hang). Build it once and reuse.

Semantics: missing cookie → `Session.get` returns an empty Session (it does not
throw), `accountId` undefined → **401**; adapter/lookup failure → catch →
**503**; Caddy's access log can therefore distinguish "no login yet" from
"provider broken". A forged cookie value 401s (empty session), verified.

## Driving a login with curl (what the Playwright suite will automate)

Works because `oidc-mock` publishes 3344 to the host. `--resolve` points the
portal hostname at the published port; the **Cookie header must be copied by
hand** — curl's cookie jar refuses `Domain=oidctest.localhost` (same
public-suffix edge as the browser caveat below), but a manual `-H "Cookie: …"`
bypasses the jar entirely:

```sh
# 1. auth request → 303 /interaction/:uid
LOC=$(curl -s -o /dev/null -D - --resolve portal.oidctest.localhost:3344:127.0.0.1 \
  'http://portal.oidctest.localhost:3344/auth?client_id=komodo-harness&response_type=code&scope=openid%20email%20profile&redirect_uri=https%3A%2F%2Fkomodo.oidctest.localhost%2Fauth%2Foidc%2Fcallback&code_challenge=<CHALLENGE>&code_challenge_method=S256&state=s&nonce=n' \
  | grep -i '^location' | sed 's/^[Ll]ocation: //; s/\r//')
# 2. dev-interaction login POST (any credentials; findAccount echoes the login)
RESUME=$(curl -s -o /dev/null -D - -d 'prompt=login&login=alice&password=x' \
  "http://portal.oidctest.localhost:3344$LOC" | grep -i '^location' | sed 's/^[Ll]ocation: //; s/\r//')
# 3. resume → 303 redirect_uri with code; grab _session from the Set-Cookie line
#    (consent is auto-skipped by loadExistingGrant — one POST total)
# 4. forward_auth check
curl -H "Cookie: _session=<value>" http://127.0.0.1:3344/verify   # → 200 ok
```

Also verified end-to-end 2026-10-01: code → `POST /token`
(`client_secret_basic` + PKCE S256) → 200 with id_token (`sub=alice`,
`aud=komodo-harness`) and access_token; `GET /me` with the bearer token →
`{"sub":"alice","email":"alice@oidctest.local"}` (userinfo is the `/me` route
in v9 — komodo's OIDC config should read the profile from userinfo, since the
id_token carries only `sub`).

> **Task 3 caveat:** discovery endpoints are built from the *request* origin,
> not the issuer config (v9 behavior — fetch discovery via
> `http://oidc-mock:3344` and every endpoint URL comes back as
> `http://oidc-mock:3344/...`). The Caddy vhost for
> `https://portal.oidctest.localhost` must serve discovery so the
> browser-facing endpoint URLs come back with the portal origin.

## Cookie caveat

The mock sets its session cookie on the parent domain `oidctest.localhost` — required
so that Caddy's `forward_auth` subrequest (originating at `komodo.oidctest.localhost`)
can see the portal's cookie. Host-only cookies for `portal.oidctest.localhost` would
401 every komodo request, including `/auth/oidc/callback`, and no login could ever
complete. If a test browser rejects `Domain=` attributes under `.localhost` (public
suffix list edge), switch the harness hosts to a `*.oidctest.test` style name plus
`/etc/hosts` entries — do **not** drop the parent-domain cookie.

## Layout

| File | Purpose |
|------|---------|
| `../oidc-dev.compose.yaml` | The harness project (mongo + core + oidc-mock; caddy/Playwright land in later tasks) |
| `core-ui.Dockerfile` | Stage 1 = `ui/Dockerfile`'s builder on this branch; stage 2 = digest-pinned core image + `COPY --from=builder /builder/ui/dist /app/ui` |
| `core-config.toml` | Mounted read-only at `/config/config.toml`; field names validated against `config/core.config.toml` |
| `oidc-mock/` | The OIDC provider (`oidc-provider@9.12.2`, in-memory adapter, dev interactions) + `/verify` forward-auth endpoint on :3344 |
| `.env` | LOCAL ONLY, gitignored — `KOMODO_CORE_IMAGE` digest pin |
