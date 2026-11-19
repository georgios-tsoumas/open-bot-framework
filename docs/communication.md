# Communication: open-bot-framework

> 1-hop view of how this service communicates with its siblings.
> Full system view: [`docs/architecture/service-communication.md`](../../hbf-agentic-framework/docs/architecture/service-communication.md)

open-bot-framework (OBF) is a self-hosted, drop-in replacement for Azure Direct Line. A browser widget speaks
Direct Line 3.0 to OBF, OBF forwards the activity to the bot's registered HTTP endpoint, and the bot posts its
replies back through the Bot Connector-shaped `/v3/conversations/...` routes. The loop closes because OBF stamps
`activity.serviceUrl = DIRECTLINE_HOST` on every activity it hands to the bot
(`src/features/directline/directline-conversation.service.ts:250`).

## Calls Out To

| Service | Protocol | Purpose | Key calls / queues |
|---------|----------|---------|-------------------|
| hbf-bot (or any registered OpenBot backend) | HTTP POST | Forward the user's activity to the bot | `POST <OpenBot.endpoint>` -- the endpoint is a **per-bot database column** (`src/entities/openbot.entity.ts:23`), not an env var. 5000 ms timeout, **no auth header** (`directline-conversation.service.ts:161-164`). Confidence: high |
| Browser widget | WebSocket (server push) | Deliver `Transcript` payloads to the connected client | Own `ws.Server` on `SOCKET_PORT` (default 1992), path `/v3/directline/conversations/:convId/stream?t=<token>` (`src/features/directline/directline.gateway.ts:20-45`). Confidence: high |

For hbf-bot deployments, `OpenBot.endpoint` typically points at `POST /api/webchat-events` on hbf-bot (seeded by
`seed-obf.sh`). OBF itself does not know or care what is behind the URL.

## Called By

| Service | Protocol | How |
|---------|----------|-----|
| hbf-webchat (or any Direct Line-compatible widget) | HTTPS + WebSocket | Direct Line 3.0: token generate/refresh, conversation create/get, activity send/upload, then a WebSocket stream for replies. hbf-webchat needs no OBF-specific code; it just receives `domain` + `tokenURL` in its hbf-core deployment config. |
| hbf-bot (or any registered bot backend) | HTTP POST | Replies via `POST /v3/conversations/:convId/activities[/:activityId]` using an OAuth2 client-credentials bearer token obtained from `POST /oauth2/v2.0/token`. hbf-bot side: `MicrosoftBotFrameworkClient.ts:292-295,314-331`, per-deployment `botOauthTokenUrl`. |
| Ops / admin tooling | HTTPS REST | Bot, credential, and webchat channel CRUD under `/api/bots*`, behind `JwtAuthGuard`. |

## Contracts

### Inbound

| Method | Path | Auth |
|--------|------|------|
| POST | `/v3/directline/tokens/generate` | `Authorization: Bearer <webchat site secret>` |
| POST | `/v3/directline/tokens/refresh` | `Authorization: Bearer <Direct Line token>` |
| POST | `/v3/directline/conversations` | Bearer site secret or Direct Line token |
| GET | `/v3/directline/conversations/:convId` | Bearer Direct Line token |
| POST | `/v3/directline/conversations/:convId/upload` | Bearer Direct Line token (multipart: `activity` part + `file` parts) |
| POST | `/v3/directline/conversations/:convId/activities` | Bearer Direct Line token |
| WS | `{DIRECTLINE_SOCKET_URL}/v3/directline/conversations/:convId/stream?t=<token>` on `SOCKET_PORT` | Direct Line token in the `t` query param; conversation id in the path must match the token's `conv` claim |
| POST | `/v3/conversations/:convId/activities/:activityId` | `Authorization: Bearer <OAuth2 access token>` (bot reply) |
| POST | `/v3/conversations/:convId/activities` | `Authorization: Bearer <OAuth2 access token>` (bot reply, no activity id) |
| POST | `/oauth2/v2.0/token` | Body `{ grant_type: "client_credentials", client_id: <botHandle>, client_secret: <plainSecret>, scope? }` |
| POST | `/api/login` | Body `{ username, password }`; returns an admin JWT |
| GET/POST/PUT/DELETE | `/api/bots`, `/api/bots/:id` | `JwtAuthGuard` (Bearer admin JWT) |
| GET/POST/PUT/DELETE | `/api/bots/:botId/credentials[/:id]` | `JwtAuthGuard` |
| GET/POST/PATCH/DELETE | `/api/bots/:botId/webchat[/:id]` | `JwtAuthGuard` |

Representative payloads:

```jsonc
// POST /v3/directline/tokens/generate
// -> { "conversationId": "...", "token": "...", "expires_in": 3600 }

// POST /v3/directline/conversations
// { "user": { "id": "..." } }
// -> { "conversationId": "...", "token": "...", "expires_in": 3600, "streamUrl": "wss://.../stream?t=..." }

// POST /v3/directline/conversations/:convId/activities
// Bot Framework Activity  ->  { "id": "<conversationId>|0000001" }

// POST /v3/conversations/:convId/activities/:activityId   (bot reply)
// Bot Framework Activity  ->  { "id": "<conversationId>|<watermark>" }

// POST /oauth2/v2.0/token
// -> { "access_token": "...", "token_type": "Bearer", "expires_in": 3600 }
```

The WebSocket server pushes `Transcript` objects (`{ activities: [...] }`) as JSON strings.

### Outbound

| Target | Auth | Env vars |
|--------|------|----------|
| Bot backend (`POST <OpenBot.endpoint>`) | **None** -- no header is attached; 5 s timeout | None. The URL is the `endpoint` column of the `open_bot` row, resolved via `findByHandleCached`. |
| WebSocket clients | Direct Line token verified at connect | `SOCKET_PORT` (default 1992), `DIRECTLINE_SOCKET_URL` (used to build the advertised `streamUrl`) |
| PostgreSQL (TypeORM) | DB credentials | `TYPEORM_CONNECTION`, `TYPEORM_HOST`, `TYPEORM_PORT`, `TYPEORM_USERNAME`, `TYPEORM_PASSWORD`, `TYPEORM_DATABASE`, `TYPEORM_AUTORUN_MIGRATIONS` |
| Redis (activity watermark counters, 1 h TTL, key = conversation id) | `REDIS_URI` | `REDIS_URI`, `ATOMIC_OPERATIONS_IMPLEMENTATION` (falls back to an in-process implementation) |
| S3-compatible object storage (attachment uploads) | Access/secret key | `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_REGION_S3`, `STORAGE_FORCE_S3_PATH_STYLE`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` |
| Token signing / identity | -- | `JWT_SECRET`, `JWT_EXPIRATION_SECONDS` (default 3600), `DIRECTLINE_HOST` (stamped as `activity.serviceUrl`), `DIRECTLINE_REGION`, `PORT` (default 1986) |

### Scaling constraint

The WebSocket gateway keeps live sockets in a plain in-process `Map` keyed by conversation id
(`directline.gateway.ts:13`). There is no pub/sub fan-out, so **OBF is single-instance only**: a second replica
would not be able to push replies to a conversation whose socket landed on the first one.

## Flows Involving This Service

- [Message Processing](../../hbf-agentic-framework/docs/architecture/flows/message-processing.md) -- OBF replaces hosted Azure Direct Line for self-hosted deployments
