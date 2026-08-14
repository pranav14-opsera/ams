# Multi-stage build: compile NestJS with TypeScript strict mode, ship only
# dist/ and production node_modules/ in the runtime image (no source, no
# devDependencies, no build toolchain in the final layer).

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# TypeScript strict mode (tsconfig.json) fails this step on any type error
# — see acceptance criteria: "build fails on any type error".
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "require('http').get('http://localhost:3000/health/live', r => process.exit(r.statusCode === 200 ? 0 : 1))"
CMD ["node", "dist/main.js"]
