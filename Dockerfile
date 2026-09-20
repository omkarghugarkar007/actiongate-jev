FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/decision-provider/package.json packages/decision-provider/package.json
COPY packages/sdk-js/package.json packages/sdk-js/package.json
COPY packages/mcp-gateway/package.json packages/mcp-gateway/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/evals/package.json packages/evals/package.json
COPY examples/refund-agent/package.json examples/refund-agent/package.json
RUN pnpm install --frozen-lockfile
COPY . .
USER node
CMD ["./node_modules/.bin/tsx", "apps/api/src/server.ts"]
