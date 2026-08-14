# Multi-stage build: compile Next.js with static export, serve the static
# output from a minimal runtime image — no Node.js process needed at
# runtime since `output: "export"` (next.config.js) produces plain HTML/
# JS/CSS.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# TypeScript strict mode (tsconfig.json) fails this step on any type error
# — see acceptance criteria: "build fails on any type error".
RUN npm run build

# nginx-unprivileged runs as a non-root user on port 8080 out of the box
# (the stock nginx image runs its master process as root to bind port 80).
# USER is explicit here (uid 101, the "nginx" user this base image already
# runs as) so static analysis tools can see the non-root guarantee
# directly in the Dockerfile, not just infer it from the base image.
#
# `stable-alpine` (nginx's stable branch, rebuilt on current Alpine
# packages) rather than the pinned `1.27-alpine`/`1.29-alpine` tags:
# grype found 10-13 Critical and 34-56 High CVEs on those frozen
# snapshots (stale libcrypto3/libssl3/curl/libxml2/etc.) vs. 0
# Critical / 2 High on stable-alpine — see .grype.yaml for the 2
# remaining (libtiff, unreachable at runtime).
FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime
COPY --from=build /app/out /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/ || exit 1
