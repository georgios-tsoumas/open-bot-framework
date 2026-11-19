# Architecture: open-bot-framework

## Component Diagram

```mermaid
flowchart LR
    webchatClient(["Webchat Client<br/>(hbf-webchat widget)"])
    adminBrowser(["Admin Browser"])
    botBackend(["Bot Backend<br/>(hbf-bot /api/webchat-events)"])

    subgraph HTTP["HTTP API :1986 (Fastify)"]
        spa["ServeStaticModule<br/>client/dist SPA"]
        authCtrl["AuthorizationController<br/>/api/login, /oauth2/v2.0/token"]
        dlCtrl["DirectlineController<br/>/v3/directline/..."]
        dlAltCtrl["DirectlineAltController<br/>/v3/conversations/:id/activities"]
        botCtrl["OpenBotController<br/>/api/bots"]
        secretCtrl["OpenBotSecretController<br/>/api/bots/:botId/credentials"]
        webchatCtrl["WebChatController<br/>/api/bots/:botId/webchat"]
        guard{{"JwtAuthGuard"}}
    end

    subgraph WS["WebSocket :1992 (ws)"]
        dlGateway["DirectLineGateway<br/>own ws.Server, conv -> socket map"]
    end

    subgraph Services
        authSvc["AuthorizationService<br/>JWT sign/verify"]
        tokenSvc["DirectlineTokenService<br/>generate/refresh/verify DL token"]
        convSvc["DirectlineConversationService<br/>conversation lifecycle, activity routing"]
        botSvc["OpenBotService<br/>bot CRUD + cached handle lookup"]
        secretSvc["OpenBotSecretService<br/>SHA-256 hash + validate"]
        webchatSvc["WebChatService<br/>channel CRUD + cached lookup"]
        storageSvc["StorageService<br/>MinIO client upload"]
        atomicSvc["AtomicOperationsService<br/>watermark counter"]
    end

    subgraph Data
        db[("TypeORM DB<br/>postgres or mysql, obf")]
        redis[("Redis<br/>counters")]
        s3[("S3-compatible<br/>storage")]
    end

    adminBrowser --> spa
    adminBrowser -->|"REST + admin JWT"| botCtrl
    adminBrowser -->|"POST /api/login"| authCtrl
    webchatClient -->|"REST + Bearer secret/token"| dlCtrl
    webchatClient -->|"wss ...?t=token"| dlGateway
    botBackend -->|"POST activity reply"| dlAltCtrl
    botBackend -->|"client_credentials"| authCtrl

    botCtrl --> guard
    secretCtrl --> guard
    webchatCtrl --> guard
    guard --> authSvc

    dlCtrl --> tokenSvc
    dlCtrl --> convSvc
    dlAltCtrl --> convSvc
    authCtrl --> authSvc
    authSvc --> secretSvc

    dlGateway -->|"verify t= token"| tokenSvc
    tokenSvc --> webchatSvc
    convSvc --> tokenSvc
    convSvc --> authSvc
    convSvc --> botSvc
    convSvc --> dlGateway
    convSvc --> storageSvc
    convSvc --> atomicSvc
    convSvc -->|"HTTP POST activity, 5s timeout"| botBackend

    botCtrl --> botSvc
    secretCtrl --> secretSvc
    webchatCtrl --> webchatSvc

    botSvc --> db
    secretSvc --> db
    webchatSvc --> db

    atomicSvc -->|"redis impl"| redis
    storageSvc --> s3
```

## Flow: User Sends Message

```mermaid
flowchart TD
    A["POST /v3/directline/conversations/:id/activities<br/>(or /upload for multipart)"] --> B["Verify DirectLine JWT<br/>conv claim must match :id"]
    B --> C["Set recipient = bot@site"]
    C --> D["Upload attachments to S3<br/>(upload route only)"]
    D --> E["Increment watermark counter<br/>id = convId|0000001"]
    E --> F["Enrich: timestamp, serviceUrl, conversation"]
    F --> G["Look up bot endpoint<br/>(cached by handle)"]
    G --> H["HTTP POST activity to bot endpoint"]
    H --> I["Echo activity to the client<br/>over the conversation WebSocket"]
    I --> J["Return { id: activityId }"]
```

## Flow: Bot Replies

```mermaid
flowchart TD
    A["POST /v3/conversations/:id/activities[/:actId]"] --> B["Verify access token<br/>(signature only)"]
    B --> C["Set replyToId when :actId present"]
    C --> D["Increment watermark counter<br/>(skipped for typing)"]
    D --> E["Enrich: timestamp, serviceUrl, conversation"]
    E --> F["Send Transcript over WebSocket<br/>with watermark (omitted for typing)"]
    F --> G["Return { id: activityId }"]
```

## Notes

- Two listeners: Fastify HTTP on `PORT` (1986) and a separate raw `ws` server on `SOCKET_PORT` (1992). The gateway is a plain `@Injectable()` that creates its own `ws.Server`, so Nest's WebSocket adapter is not involved.
- The same HTTP port serves the React admin SPA from `client/dist` via `ServeStaticModule` with `fallthrough: true` (required for Fastify's static loader to serve the SPA index for client-side routes).
- The DB driver comes from `TYPEORM_CONNECTION`: `postgres` in `.env` and `docker-compose.yml`, `mysql` in HBF local dev. `synchronize: true` is always on, so the schema auto-syncs at startup and the `migrations/` directory does not exist yet.
- Nothing is persisted per conversation or per activity. Conversations live only in the JWT (`conv` claim) plus the counter key; activity history is not stored, so `watermark`-based replay is not supported.
- WebSocket auth: the gateway parses `?t=<DirectLine token>`, verifies it ignoring expiry, and requires the path to be `/v3/directline/conversations/<conv>/stream` with `conv` matching the token claim. Sockets are held in a plain `Map`, one per conversation, and are never removed on close, so this is single-instance only.
- `sendToConversation` retries three times with 1s/2s/3s sleeps if the socket is not registered yet, then logs a warning and drops the transcript.
- Atomicity backend is chosen once at boot from `ATOMIC_OPERATIONS_IMPLEMENTATION`; Redis keys carry a 1h TTL, and a failed Redis connect silently falls back to the in-memory manager (documented as emergency-only).
- Activity ids follow the DirectLine convention `<conversationId>|<7-digit counter>`; `typing` activities get a random suffix instead and neither increment nor carry a watermark.
- Bot client secrets are SHA-256 hashed (`AuthorizationUtils.createHash`), not bcrypt. Only the admin password uses bcrypt. `plainReducted` keeps the first 3 characters for display.
- All three token types (admin, client-credentials, DirectLine) are signed with the same `JWT_SECRET`, and `verifyAccessToken` checks only the signature, so the bot-reply endpoints accept any token this service issued.
- `StorageService` builds its MinIO client in the constructor and throws when `STORAGE_ENDPOINT` or `STORAGE_BUCKET` is missing, which aborts application boot.
