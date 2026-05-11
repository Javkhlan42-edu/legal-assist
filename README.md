# Mongolian Legal RAG Chatbot

> Монголын хууль тогтоомж, шүүхийн шийдвэрийн RAG чатбот — Бакалаврын дипломын ажил

## Architecture

This is a **Modular Monolith** built as a pnpm monorepo with three apps and two shared packages:

| Package           | Description                                     |
| ----------------- | ----------------------------------------------- |
| `apps/web`        | Next.js 14 frontend (chat UI)                   |
| `apps/api`        | Fastify API server (RAG pipeline)               |
| `apps/worker`     | Ingestion worker (crawl, chunk, embed)          |
| `packages/shared` | Shared TypeScript types, Zod schemas, constants |
| `packages/ui`     | Shared React UI components                      |

**Data Sources:**

- **shuukh.mn** — Mongolian court decisions
- **legalinfo.mn** — Mongolian legal acts

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the complete system design document.

## Quick Start

### Prerequisites

- Node.js >= 20
- pnpm >= 9
- Docker (for PostgreSQL + ChromaDB)

### Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Start infrastructure (Postgres + ChromaDB)
docker compose -f docker/docker-compose.yml up -d

# 3. Copy env files
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
cp apps/worker/.env.example apps/worker/.env

# 4. Start development servers
pnpm dev
```

This starts:

- **Web** at http://localhost:3000
- **API** at http://localhost:3001
- **PostgreSQL** at localhost:5432
- **ChromaDB** at localhost:8000

### Worker (manual ingestion)

```bash
# Ingest from all sources
pnpm --filter @legal-chatbot/worker ingest

# Ingest from a specific source
pnpm --filter @legal-chatbot/worker ingest:shuukh
pnpm --filter @legal-chatbot/worker ingest:legalinfo
```

### Scripts

```bash
pnpm dev          # Start all apps in dev mode
pnpm build        # Build all packages
pnpm lint         # Lint all packages
pnpm typecheck    # TypeScript type checking
pnpm test         # Run all tests
pnpm seed:priority:refresh  # Refresh legalinfo priority seed URLs
pnpm ingest:seed-priority   # Ingest priority legalinfo laws only
pnpm test:chat-regression   # Run chat regression prompts
pnpm format       # Format code with Prettier
```

## API Endpoints

| Method | Path                | Description                   |
| ------ | ------------------- | ----------------------------- |
| POST   | `/v1/chat`          | Chat with the legal assistant |
| GET    | `/v1/conversations` | List conversations            |
| POST   | `/v1/feedback`      | Submit answer feedback        |
| GET    | `/health`           | Health check                  |

## Project Structure

```
├── apps/
│   ├── api/          # Fastify API (RAG pipeline)
│   ├── web/          # Next.js frontend
│   └── worker/       # Ingestion worker
├── packages/
│   ├── shared/       # Types, schemas, constants
│   └── ui/           # Shared React components
├── docker/           # Docker configs
├── scripts/          # Utility scripts
└── ARCHITECTURE.md   # Full architecture document
```

## License

Bachelor thesis project — All rights reserved.
