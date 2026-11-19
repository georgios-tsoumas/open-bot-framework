---
generated-from: open-bot-framework@97f9e75
last-verified: 2026-07-31
---

# AI Brief: open-bot-framework

> Self-hosted DirectLine 3.0 gateway (OBF). Replaces Azure's hosted DirectLine service. hbf-webchat calls OBF for tokens and activity delivery; OBF forwards user activities to the registered bot endpoint (hbf-bot `POST /api/webchat-events`) over HTTP and streams bot replies back to the widget over a WebSocket. Ships with a small React admin SPA for managing bots, credentials, and webchat channels.

## What This Repo Does

Implements the Microsoft Bot Framework DirectLine 3.0 protocol as a standalone NestJS service: bot registration, webchat channel secrets, conversation and token lifecycle, activity relay, attachment upload, and real-time delivery via WebSocket. The bundled `client/` workspace is a React admin UI served by the same process from `client/dist`.

## Tech Stack

- Language: TypeScript (Node 22, CommonJS, SWC via `nest build`)
- Framework: NestJS 11 with the **Fastify** adapter
- Key dependencies: TypeORM (driver chosen at runtime by `TYPEORM_CONNECTION`; both `pg` and `mysql2` are installed), `ioredis`, `minio` (S3-compatible storage), `ws` (raw WebSocket server), `@nestjs/jwt`, `bcrypt` (admin login only), `class-validator`, `botframework-schema` (types only, a devDependency)
- Client: React 18 + Vite 5 + Tailwind 3 + react-router-dom 6 + axios (npm workspace `client/`, package name `openbot-ui`)

## Entry Points

- Main: `src/main.ts` — Fastify bootstrap, `@fastify/multipart` (10 MB file limit), global `ClassSerializerInterceptor` and `AllExceptionsFilter`, CORS `origin: true`, listens on `0.0.0.0:${PORT ?? 1986}`
- WebSocket: `src/features/directline/directline.gateway.ts` — a plain injectable that starts its own `ws` `Server` on `SOCKET_PORT` (default 1992) in `onModuleInit`. It is **not** a `@WebSocketGateway`; `@nestjs/websockets` / `@nestjs/platform-ws` are installed but unused.
- Admin SPA: `client/src/main.tsx` → built to `client/dist`, served by `ServeStaticModule` on the HTTP port
- Config: `.env.local` then `.env` (`ConfigModule.forRoot({ envFilePath: ['.env.local', '.env'] })`)
- Migration CLI datasource: `ormconfig.ts` → `dist/ormconfig.js` (loads `<repo>/.env.local`)

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/features/directline/` | DirectLine 3.0: token issue/refresh/verify, conversation lifecycle, activity routing, WebSocket server |
| `src/features/authorization/` | `/api/login` (admin) and `/oauth2/v2.0/token` (client credentials), JWT sign/verify, crypto helpers |
| `src/features/openbot/` | CRUD for registered bots (`handle` + HTTP `endpoint`) |
| `src/features/openbotsecret/` | CRUD for bot client credentials (SHA-256 hashed), exposed at `/api/bots/:botId/credentials` |
| `src/features/channels/webchat/` | CRUD for webchat channels and their two site secrets |
| `src/features/atomicity/` | Per-conversation activity counter (watermark): Redis or in-memory |
| `src/features/storage/` | MinIO-client upload of conversation attachments to S3-compatible storage |
| `src/entities/` | TypeORM entities: `OpenBot`, `OpenBotSecret`, `WebChatChannel` |
| `src/dto/` | Request/response DTOs and JWT payload types |
| `src/guards/` | `JwtAuthGuard` protecting all `/api/bots**` admin routes |
| `src/filters/` | Global exception filter (uniform JSON error body) |
| `client/src/` | React admin SPA: pages, components, auth/theme contexts, axios API client |

## API Surface

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/login` | none | Admin login; bcrypt-compares against `ADMIN_PASSWORD` hash, returns `access_token` |
| POST | `/oauth2/v2.0/token` | `client_id` + `client_secret` in body | Client-credentials token for bot backends |
| POST | `/v3/directline/tokens/generate` | Bearer webchat secret (`<siteId>.<random>`) | Issue DirectLine token + conversation id |
| POST | `/v3/directline/tokens/refresh` | Bearer DirectLine token | Re-issue DirectLine token |
| POST | `/v3/directline/conversations` | Bearer secret or DirectLine token | Create conversation, returns `streamUrl` |
| GET | `/v3/directline/conversations/:convId?watermark=` | Bearer DirectLine token | Conversation metadata + `streamUrl`; **sets** the watermark counter |
| POST | `/v3/directline/conversations/:convId/activities` | Bearer DirectLine token | User sends an activity |
| POST | `/v3/directline/conversations/:convId/upload` | Bearer DirectLine token | Multipart upload; parts named `activity` (JSON) and `file` |
| POST | `/v3/conversations/:convId/activities/:activityId` | Bearer access token | Bot replies to a specific activity (sets `replyToId`) |
| POST | `/v3/conversations/:convId/activities` | Bearer access token | Bot/livechat agent sends without a reply target |
| GET POST PUT DELETE | `/api/bots`, `/api/bots/:id` | `JwtAuthGuard` | Bot CRUD (paginated list) |
| GET POST PUT DELETE | `/api/bots/:botId/credentials[/:id]` | `JwtAuthGuard` | Bot client-credential CRUD |
| GET POST PATCH DELETE | `/api/bots/:botId/webchat[/:id]` | `JwtAuthGuard` | Webchat channel CRUD |
| GET | `/*` | none | Admin SPA static assets from `client/dist` (fallthrough enabled) |

## Data Models

- `OpenBot` — registered bot backend: `id` (uuid), `handle` (unique, `IDX_OpenBot_handle`), `endpoint` (HTTP URL the gateway POSTs activities to), `schemaVersion` (default `v1.3`; `create()` overrides with `V1.3`), `createdAt`, `updatedAt`
- `OpenBotSecret` — client credential for a bot: `id` (uuid, used as `client_id`), `openBot` (FK, cascade delete), `description`, `secretHash` (SHA-256 hex of a 40-char random string), `plainReducted` (first 3 chars, for display), `expiresAt` (nullable, **stored but never enforced**), `createdAt`
- `WebChatChannel` — webchat site: `id` (11-char random string, **not** a UUID), `openBot` (FK, cascade delete), `name`, `secret1`, `secret2` (both `<channelId>.<base64url 32 bytes>`, indexed), `createdAt`

Three JWT flavours, all signed with the same `JWT_SECRET` (HS256):

- Admin token — `{ sub: username }`, guards `/api/bots**`
- Access token — `{ sub: clientId, aud: scope ?? 'https://api.botframework.com/.default' }`, used by bot backends on `/v3/conversations/...`
- DirectLine token — `{ bot, site, conv, user, iss/aud: https://<DIRECTLINE_HOST>/ }`, used by the widget

## External Dependencies

- Database: TypeORM with `synchronize: true`. `TYPEORM_CONNECTION` picks the driver — `postgres` in `.env` and `docker-compose.yml`, **`mysql` in HBF local dev** (generated by `scripts/local-dev/generate-env.sh`). Database name `obf`.
- Cache: in-process `@nestjs/cache-manager` (global) for bot/secret/channel lookups
- Atomicity: Redis via `ioredis` (`REDIS_URI`), or in-memory fallback (`ATOMIC_OPERATIONS_IMPLEMENTATION=memory`, or automatically when Redis is unreachable at boot)
- Storage: S3-compatible object storage via the MinIO client (MinIO locally; S3/Wasabi/Spaces supported). `STORAGE_ENDPOINT` and `STORAGE_BUCKET` are **required at construction** — the app fails to boot without them.
- Bot backends: any HTTP endpoint registered as an `OpenBot`. In HBF that is hbf-bot at `/api/webchat-events`.

## Running Locally

```bash
npm run start:dev   # builds the SPA in dev mode, then runs `nest start --watch` + the Vite watch build concurrently
npm run client:dev  # SPA alone on the Vite dev server (proxies /api to :1986)
```

HBF local dev (`./scripts/aq-local-dev.sh start open-bot-framework`, host only) generates `.env.local` with HTTP `4218`, WebSocket `4219`, MySQL on `127.0.0.1:13306`, MinIO on `:19000`, Redis on `:16379`. Standalone defaults are HTTP `1986` / WebSocket `1992`.

Seed the platform to route through OBF instead of Microsoft DirectLine: `./scripts/aq-local-dev.sh seed-obf` (host only).

## Tests

```bash
npm run test        # Jest; currently only src/sanity.spec.ts
npm run lint        # ESLint flat config (eslint.config.mjs) --fix
npm run build       # nest build -> dist/src/main.js
```

CI (`.github/workflows/ci.yml`) runs `npm test`, a SonarQube scan, then builds and pushes an image to ECR and rolls out to EKS (`helvia-dev` / `helvia-stg` / `helvia`) on `develop` / `staging` / `main`.

## Gotchas

- `package.json` `start:prod` is `node dist/main`, but `nest build` emits `dist/src/main.js` (because `ormconfig.ts` sits outside `src/`). The Dockerfile is correct (`node dist/src/main`); the npm script is not.
- The plain `.env` leaves `STORAGE_ENDPOINT` commented out, so booting with it alone throws `STORAGE_ENDPOINT is required` from `StorageService`.
- `cacheManager.wrap(key, fn, 10)` — cache-manager v7 measures TTL in **milliseconds**, so these caches live ~10 ms. Cache keys are also unprefixed raw ids (`handle`, secret id, channel id) in one global store.
- `WebChatController` validates `:id` with `ParseUUIDPipe`, but channel ids are 11-char random strings, so per-channel GET/PATCH/DELETE reject real ids.
- The multipart upload loop only inspects parts where `part.type === 'file'`; the `activity` JSON must be sent as a file part, not a plain field. The `userId` query param is accepted and ignored.
- All three token types share one `JWT_SECRET` and `verifyAccessToken` only checks the signature, so tokens are not role-separated.
