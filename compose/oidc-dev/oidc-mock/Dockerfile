# Build context is compose/oidc-dev (see oidc-dev.compose.yaml build.context),
# hence the oidc-mock/ prefix on every COPY path.
FROM node:22.12-alpine
WORKDIR /app
# yarn.lock is committed; --frozen-lockfile makes the build fail loudly on
# package.json/lockfile drift instead of silently resolving a newer tree.
# The `|| yarn install` fallback only fires if the lockfile is ever removed.
COPY oidc-mock/package.json ./
RUN yarn install --frozen-lockfile || yarn install
COPY oidc-mock/index.mjs ./
ENV MOCK_ISSUER=https://portal.oidctest.localhost
EXPOSE 3344
CMD ["yarn", "start"]
