# AI Index: open-bot-framework

> Context groups for agent sessions. Load only what's relevant.
> Paths starting with `docs/architecture/` live in the **framework repo** unless marked "(this repo)".

## Base Context (always load)

1. `docs/AI_BRIEF.md` — repo summary, API surface, data models, gotchas
2. `AGENTS.md` (this repo, symlinked as `CLAUDE.md`) — conventions and commands
3. `docs/architecture.md` — component diagram and the two activity flows

## Context Groups

### directline
Files relevant to DirectLine 3.0 protocol work:
- `src/features/directline/directline.controller.ts` — client-facing endpoints under `/v3/directline`
- `src/features/directline/directline-alt.controller.ts` — bot-facing reply endpoints under `/v3/conversations`
- `src/features/directline/directline-conversation.service.ts` — conversation create/get, activity enrichment, bot HTTP forward
- `src/features/directline/dirtectline-token.service.ts` — token generate/refresh/verify (note the typo in the filename)
- `src/features/directline/directline.gateway.ts` — standalone `ws` server, per-conversation socket map
- `src/features/directline/directline.module.ts` — module wiring
- `src/dto/directline.dto.ts` — token response and JWT payload types
- `src/dto/conversation.dto.ts` — conversation response shape

### auth
Load when working on auth guards, token validation, or protected endpoints:
- `docs/auth.md` — tokens this service accepts, sends, and issues
- `docs/architecture/auth-flows.md` (framework repo) — platform auth sequence diagrams (Flow 6 covers OBF)
- `src/features/authorization/authorization.controller.ts` — `/api/login` and `/oauth2/v2.0/token`
- `src/features/authorization/authorization.service.ts` — admin login (bcrypt), client credentials, verify
- `src/features/authorization/authorization.utils.ts` — bearer extraction, secret/hash/random helpers
- `src/guards/jwt-auth.guard.ts` — guard applied to every `/api/bots**` controller
- `src/dto/token.dto.ts` — login and access-token request DTOs

### bots
Files relevant to bot and credential management:
- `src/features/openbot/openbot.controller.ts` — `/api/bots` CRUD
- `src/features/openbot/openbot.service.ts` — find/create/update/delete, cached handle lookup
- `src/features/openbotsecret/openbotsecret.controller.ts` — `/api/bots/:botId/credentials` CRUD
- `src/features/openbotsecret/openbotsecret.service.ts` — SHA-256 hashing and validation
- `src/entities/openbot.entity.ts` — `OpenBot` + `OpenBotSecret` entities
- `src/dto/openbot.dto.ts` — OpenBot/OpenBotSecret DTOs and the handle format validator

### webchat-channel
Files relevant to webchat channel management:
- `src/features/channels/webchat/webchat.controller.ts` — `/api/bots/:botId/webchat` CRUD
- `src/features/channels/webchat/webchat.service.ts` — channel create/update/delete, secret regeneration
- `src/entities/webchat.entity.ts` — `WebChatChannel` entity (11-char non-UUID id)
- `src/dto/webchat.dto.ts` — WebChatChannel DTO

### admin-ui
Load when working on the bundled React admin SPA (`client/` npm workspace):
- `client/src/App.tsx` — routes (`/login`, `/bots`, `/bots/:botId`, `/credentials`, `/webchat`)
- `client/src/services/api.ts` — axios client, token storage, every backend call the UI makes
- `client/src/context/AuthContext.tsx` — login state and 401 handling
- `client/src/pages/` — one page per admin screen
- `client/vite.config.ts` — dev vs production output naming, `/api` proxy to `:1986`
- `src/app.module.ts` — `ServeStaticModule` serving `client/dist`

### storage
Files relevant to attachment upload:
- `src/features/storage/storage.service.ts` — MinIO-client upload, object key generation, boot-time env checks
- `src/dto/upload.dto.ts` — multipart file DTO
- `src/features/directline/directline.controller.ts` — the `upload` route that parses multipart parts

### atomicity
Files relevant to activity watermark counters:
- `src/features/atomicity/atomic-operations.service.ts` — incr/get/set wrapper
- `src/features/atomicity/atomicity-operations-manager.interface.ts` — interface
- `src/features/atomicity/atomic-operations-manager.redis.ts` — Redis backend (1h TTL, `incr` returns value-1)
- `src/features/atomicity/atomic-operations-manager.memory.ts` — in-memory fallback
- `src/features/atomicity/atomic-operations.provider.ts` — backend selection and Redis-failure fallback

### deployment
Load when working on Docker, env vars, ports, or CI/CD for this service:
- `docs/deployment.md` — ports, required env vars, local run commands
- `Dockerfile` — three-stage build (client, server, slim runtime), `CMD node dist/src/main`
- `docker-compose.yml` — standalone stack with Postgres 16 and Redis 7
- `.env` / `.env.local.dev` — standalone vs HBF local-dev configuration
- `.github/workflows/ci.yml` — test, SonarQube, ECR build, EKS rollout
- `docs/architecture/deployment.md` (framework repo) — platform deployment reference

### data-model
Files relevant to DB schema:
- `docs/data-model.md` — field-level schemas for entities, runtime objects, and JWT payloads
- `src/entities/openbot.entity.ts`, `src/entities/webchat.entity.ts` — the three entities
- `src/app.module.ts` — TypeORM async config (`synchronize: true`, driver from `TYPEORM_CONNECTION`)
- `ormconfig.ts` — DataSource used by the TypeORM CLI for migrations

### resilience
Load when debugging timeouts, retry failures, or designing fault-tolerant changes:
- `docs/resilience.md` — retry policies, timeouts, and known gaps for this service
- `src/features/directline/directline.gateway.ts` — 3-attempt socket retry before dropping a transcript
- `src/features/directline/directline-conversation.service.ts` — 5s timeout on the bot HTTP forward
- `docs/architecture/resilience.md` (framework repo) — platform-wide patterns

### communication
Load when working on service boundaries or tracing a call chain:
- `docs/communication.md` — what this service calls and what calls it
- `docs/architecture/service-communication.md` (framework repo) — full system dependency graph
- `scripts/local-dev/seed-obf.sh` (framework repo) — how hbf-core's MessagingApp is pointed at OBF

### pipeline
Files relevant to how open-bot-framework fits into the platform message pipeline:
- `docs/architecture/nlu-pipelines.md` (framework repo) — role as DirectLine channel gateway
- `src/features/directline/directline-conversation.service.ts` — `userReplyToConversation`, `replyToActivity`
- `src/features/directline/directline.gateway.ts` — WebSocket broadcast after a bot reply

### service-internals
Load when you need the full internal reference rather than a single feature:
- `docs/architecture/bot-nodes.md` (this repo) — data models, token types, six request flows, WebSocket lifecycle, atomicity, env vars. Note: this service has no workflow node engine; bot node types live in `packages/hbf-bot`.
- `src/main.ts` — bootstrap, multipart limits, CORS, global filter and interceptor
- `src/filters/exception.filter.ts` — uniform JSON error body
- `src/dto/page.dto.ts` — pagination wrapper used by every admin list endpoint

## Technical Docs

| Module | Doc |
|--------|-----|
| Authentication | `docs/auth.md` |
| Data model | `docs/data-model.md` |
| Deployment | `docs/deployment.md` |
| Resilience | `docs/resilience.md` |
| Service communication | `docs/communication.md` |
| Service internals | `docs/architecture/bot-nodes.md` |
