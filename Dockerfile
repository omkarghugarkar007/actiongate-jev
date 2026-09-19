FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/decision-provider/package.json packages/decision-provider/package.json
COPY packages/sdk-js/package.json packages/sdk-js/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/evals/package.json packages/evals/package.json
COPY examples/refund-agent/package.json examples/refund-agent/package.json
RUN pnpm install --no-frozen-lockfile
COPY . .
CMD ["pnpm", "dev:api"]

