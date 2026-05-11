# Worker Service Dockerfile
FROM node:20-bookworm-slim

RUN corepack enable && corepack prepare pnpm@9.1.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .

WORKDIR /app/apps/worker
CMD ["pnpm", "exec", "tsx", "src/index.ts", "schedule"]
