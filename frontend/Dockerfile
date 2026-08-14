# Multi-stage build: compile Next.js with static export, serve the static
# output from a minimal runtime image — no Node.js process needed at
# runtime since `output: "export"` (next.config.js) produces plain HTML/
# JS/CSS.

FROM node:20-alpine AS build
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
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=build /app/out /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/ || exit 1
