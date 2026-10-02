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
