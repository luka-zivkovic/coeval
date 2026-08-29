# syntax=docker/dockerfile:1

FROM node:24-slim AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools/mcp ./tools/mcp

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools/mcp ./tools/mcp

RUN pnpm install --frozen-lockfile --prod

COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/db/dist ./packages/db/dist
COPY --from=build /repo/packages/queue/dist ./packages/queue/dist
COPY --from=build /repo/apps/audit/dist ./apps/audit/dist
COPY --from=build /repo/apps/api/dist ./apps/api/dist

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/src/index.js"]
