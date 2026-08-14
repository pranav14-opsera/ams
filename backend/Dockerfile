# Multi-stage build: compile NestJS with TypeScript strict mode, ship only
# dist/ and production node_modules/ in the runtime image (no source, no
# devDependencies, no build toolchain in the final layer).

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# TypeScript strict mode (tsconfig.json) fails this step on any type error
# — see acceptance criteria: "build fails on any type error".
RUN npm run build

# node:24 (current Active LTS) rather than node:20: grype found 3
# Critical / 36 High CVEs on node:20-alpine vs. 1 Critical / 7 High on
# node:24-alpine — see .grype.yaml for the remaining ones (all inside
# npm's own bundled tooling under node_modules/npm/, never invoked by
# this image's runtime CMD).
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "require('http').get('http://localhost:3000/health/live', r => process.exit(r.statusCode === 200 ? 0 : 1))"
CMD ["node", "dist/main.js"]
