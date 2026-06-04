FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
# Native build tooling for `better-sqlite3` (the OAuth token store).
# Alpine either pulls a musl prebuild (for the common x64/arm64
# architectures) or falls back to node-gyp compilation — both paths
# expect `python3`, `make`, and a C/C++ toolchain at install time.
# These land only in the builder layer; the runtime layer copies just
# `.output/`, so the final image stays the same size.
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NITRO_PORT=3000
COPY --from=builder /app/.output ./.output
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", ".output/server/index.mjs"]
