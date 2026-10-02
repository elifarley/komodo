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

- **`node-oidc-provider` version `11.10.1`** — the version the harness's mock is
  written against. Bump only with a re-run of the full suite.

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
| `../oidc-dev.compose.yaml` | The harness project (mongo + core; mock/caddy/Playwright land in later tasks) |
| `core-ui.Dockerfile` | Stage 1 = `ui/Dockerfile`'s builder on this branch; stage 2 = digest-pinned core image + `COPY --from=builder /builder/ui/dist /app/ui` |
| `core-config.toml` | Mounted read-only at `/config/config.toml`; field names validated against `config/core.config.toml` |
| `.env` | LOCAL ONLY, gitignored — `KOMODO_CORE_IMAGE` digest pin |
