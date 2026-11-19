# Auth: open-bot-framework

> How this service handles authentication.
> Full flows: [`docs/architecture/auth-flows.md`](../../docs/architecture/auth-flows.md)

> **NOT CURRENTLY DEPLOYED.** hbf-webchat connects to **Azure Bot Framework Direct Line**, not to this gateway. hbf-core relays token requests to `directline.baseurl`, which defaults to `https://directline.botframework.com/v3/directline` (`hbf-core/src/main/resources/application.properties:142`), and hbf-webchat hardcodes the Azure host in `coreWidget.ts:1509` and `:3392`. OBF is reachable only if an operator fills in the console's per-deployment "DirectLine Token URL" and domain override. Treat everything below as the design of a drop-in replacement, not as a live production surface.

open-bot-framework is a self-contained DirectLine 3.0 gateway (NestJS on Fastify, MySQL via TypeORM, Redis or in-memory for atomic counters). It has its own signing key and does not talk to hbf-core for anything, including token validation.

## Tokens This Service Accepts

Four credential shapes. **All three JWT types are signed and verified with the single `JWT_SECRET`** (`src/app.module.ts:30-37`, `JwtModule` registered globally with only `secret`, no `signOptions`, no `verifyOptions`).

| Credential | Shape | Where | Verification |
|-----------|-------|-------|--------------|
| Bot API secret | `<secretId>` + 40-char random, sent as `client_id` + `client_secret` | `POST /oauth2/v2.0/token` body | `OpenBotSecretService.validateSecretCached` (`src/features/openbotsecret/openbotsecret.service.ts:142-147`), SHA-256 hash compare |
| Admin username + password | plain | `POST /api/login` body | `AuthorizationService.generateUserToken` (`src/features/authorization/authorization.service.ts:30-55`), username equality plus `bcrypt.compare` against `ADMIN_PASSWORD` |
| WebChat site secret | `<siteId>.<base64url(32 bytes)>`, one dot | `Authorization: Bearer` on `POST /v3/directline/tokens/generate` and on `POST /v3/directline/conversations` | `DirectlineTokenService.generateToken` (`src/features/directline/dirtectline-token.service.ts:52-83`), **format check plus siteId existence only** |
| Any OBF-issued JWT | standard JWT, two dots | `Authorization: Bearer` on the DirectLine and bot-reply routes, and `?t=<token>` on the WebSocket | see below |

### JWT verify functions

There are exactly two, and neither checks `iss`, `aud`, or `sub`:

| Function | File:line | Options | Used by |
|----------|-----------|---------|---------|
| `AuthorizationService.verifyAccessToken` | `src/features/authorization/authorization.service.ts:64-70` | `jwtService.verify(token)`, defaults | `JwtAuthGuard` (`src/guards/jwt-auth.guard.ts:9-19`) and `DirectlineConversationService.replyToActivity` (`src/features/directline/directline-conversation.service.ts:201`) |
| `DirectlineTokenService.verifyDirectLineToken` | `src/features/directline/dirtectline-token.service.ts:128-134` | `jwtService.verify(token, { ignoreExpiration })` | `createConversation` (`:64`, `ignoreExpiration: false`), `getConversation` (`:114`, `false`), `userReplyToConversation` (`:146`, **`true`**), `refreshToken` (`:98`, **`true`**), WebSocket gateway (`src/features/directline/directline.gateway.ts:33`, `false`) |

`verifyAccessToken` is signature plus expiry only. Any token this gateway ever issued satisfies it, including an admin token from `/api/login` and a DirectLine token belonging to some unrelated conversation.

### Endpoint to guard map

| Endpoint | Guard |
|----------|-------|
| `POST /oauth2/v2.0/token` | client id + secret in body |
| `POST /api/login` | admin username + bcrypt password |
| `POST /v3/directline/tokens/generate` | site secret in `Authorization` |
| `POST /v3/directline/tokens/refresh` | any OBF JWT with a `site` claim that resolves, expiry ignored |
| `POST /v3/directline/conversations` | JWT (2 dots) or site secret (1 dot), chosen by counting `.` (`directline-conversation.service.ts:61-91`) |
| `GET /v3/directline/conversations/:convId` | any OBF JWT, **no conv binding** |
| `POST /v3/directline/conversations/:convId/activities` | DirectLine JWT whose `conv` equals `:convId`, expiry ignored |
| `WS /v3/directline/conversations/:convId/stream?t=` | DirectLine JWT whose `conv` equals the path segment, expiry enforced |
| `POST /v3/conversations/:convId/activities[/:activityId]` (bot reply) | `verifyAccessToken`, **any OBF JWT** |
| `/bots`, `/bots/:botId/secrets`, `/bots/:botId/webchat` (admin REST) | `@UseGuards(JwtAuthGuard)` on all three controllers |
| `/` and SPA routes | none, `ServeStaticModule` serves `client/dist` |

## Tokens This Service Sends

| Calling | Token used | How attached |
|---------|-----------|--------------|
| Bot endpoint (`OpenBot.endpoint`), forwarding user activities | **none** | `httpService.post(targetBot.endpoint, newActivity, { headers: { 'Content-Type': 'application/json' }, timeout: 5000 })` (`src/features/directline/directline-conversation.service.ts:160-165`) |
| WebChat clients over the WebSocket | none, the token was already validated at handshake | raw JSON transcript frames (`src/features/directline/directline.gateway.ts:68-84`) |
| S3-compatible object storage | `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | AWS SDK signing, for attachment uploads |
| MySQL, Redis | connection credentials from env | driver-level |

The gateway never calls hbf-core or any other HBF service, and never presents a bearer token to anything.

## Tokens This Service Issues

| Token | Endpoint | Claims | Algorithm | Expiry |
|-------|----------|--------|-----------|--------|
| Admin access token | `POST /api/login` | `{ sub: <ADMIN_USERNAME>, iat, exp }` | HS256, `JWT_SECRET` | `JWT_EXPIRATION_SECONDS`, default 3600 |
| Bot access token (client credentials) | `POST /oauth2/v2.0/token`, `grant_type=client_credentials` | `{ aud: scope ?? "https://api.botframework.com/.default", iss: <undefined>, sub: <clientId>, iat, exp }` | HS256, `JWT_SECRET` | `JWT_EXPIRATION_SECONDS`, default 3600 |
| DirectLine token | `POST /v3/directline/tokens/generate`, `POST /v3/directline/tokens/refresh`, `POST /v3/directline/conversations` | `{ bot: <bot handle>, site: <siteId>, conv: <conversationId>, user?, iss: "https://<DIRECTLINE_HOST>/", aud: "https://<DIRECTLINE_HOST>/", nbf, exp }` | HS256, `JWT_SECRET` | `JWT_EXPIRATION_SECONDS`, default 3600 |

All three responses use the OAuth2 shape `{ token_type: "Bearer", expires_in, access_token }` or the DirectLine shape `{ conversationId, token, expires_in }`.

Conversation ids are minted as `${base64url(12 random bytes)}-${DIRECTLINE_REGION}` (`dirtectline-token.service.ts:71`).

### Secret generation and storage

| Secret | Generation | Storage |
|--------|-----------|---------|
| Bot API secret | `AuthorizationUtils.generateRandom(40)` over a 55-char alphabet (`authorization.utils.ts:4-10`) | SHA-256 hex in `secretHash`, first 3 chars in `plainReducted`, plaintext returned once (`openbotsecret.service.ts:95-104`) |
| WebChat site secret | `` `${siteId}.${randomBytes(32).toString('base64url')}` `` (`authorization.utils.ts:21-23`) | **plaintext** in `secret1` / `secret2` columns (`webchat.service.ts:126-127`, regenerated on update at `:147-150`) |
| Admin password | operator-supplied | bcrypt hash in the `ADMIN_PASSWORD` env var |

Both SHA-256 and bcrypt appear in the dependency tree because they serve different credentials: SHA-256 for machine client secrets, bcrypt for the human admin password.

### WebSocket token validation

`DirectLineGateway.onModuleInit` (`src/features/directline/directline.gateway.ts:26-51`) runs a bare `ws` server on `SOCKET_PORT`, separate from the Fastify HTTP port. On connection it parses `?t=`, calls `verifyDirectLineToken(token, false)`, then requires the path to match `^/v3/directline/conversations/([^/]+)/stream$` with the captured id equal to the token's `conv`. On success the socket is registered in a `Map<convId, WebSocket>`. Any throw sends the error back and closes the socket.

## Roles / Scopes Enforced

No role model. Access is binary per credential type, and the only scoping that actually holds is the `conv` claim comparison on the user-send and WebSocket paths.

| Credential | Effectively grants |
|-----------|-------------------|
| Bot API secret | minting bot access tokens |
| Admin credentials | minting an admin token, which passes `JwtAuthGuard` on all admin REST routes **and** `verifyAccessToken` on the bot-reply route |
| WebChat site secret | minting DirectLine tokens for that site's bot |
| DirectLine token | that one conversation, on the user-send and stream paths only |

The `aud` claim on bot access tokens is attacker-influenced (it is copied verbatim from the request `scope`) and is never read back, so it grants nothing.

## Auth Notes

- `AuthorizationService.directLineHost` is declared but never assigned (`authorization.service.ts:10`), so bot access tokens carry `iss: undefined`. `DirectlineTokenService` does read `DIRECTLINE_HOST` correctly (`dirtectline-token.service.ts:21`).
- Refresh semantics: `POST /v3/directline/tokens/refresh` verifies with `ignoreExpiration: true` (`dirtectline-token.service.ts:98`), then only checks that the `site` still exists in the database before minting a fresh token with the same `bot`, `site`, `conv`, `user`. There is no refresh-token rotation, no use counter, and no absolute lifetime.
- Outbound calls to the bot carry no credential at all: `httpService.post(targetBot.endpoint, newActivity, { headers: { 'Content-Type': 'application/json' } })` (`directline-conversation.service.ts:160-165`). The bot has no way to authenticate the gateway.
- The admin SPA (`client/`, React + Vite, served from the same origin) logs in via `POST /api/login`, stores the token in `localStorage['obf_token']` (`client/src/services/api.ts:5`, `:43-45`), attaches it with an axios request interceptor (`:19-25`), and clears it plus fires `onUnauthorized` on any 401 (`:27-36`). Route guarding is a `RequireAuth` wrapper that redirects to `/login` when unauthenticated.

**Security gaps:**

- **One `JWT_SECRET` for every token type, and verification is signature-only.** `verifyAccessToken` (`authorization.service.ts:64-70`) checks nothing beyond signature and expiry. The bot-reply endpoint `POST /v3/conversations/:convId/activities[/:activityId]` (`directline-alt.controller.ts:9-28` to `directline-conversation.service.ts:201`) therefore accepts an **admin token** or a **DirectLine token from any conversation** as a bot credential. Nothing binds the caller to the bot that owns `:convId`, so any holder of any OBF-issued token can inject arbitrary bot messages into any conversation id they can guess or observe.
- **WebChat site secrets are never actually checked.** `generateToken` (`dirtectline-token.service.ts:52-83`) splits on `.`, requires both halves to be non-empty, looks the site up by `siteId`, and mints a token. The 32-byte random half is never compared against the stored `secret1`/`secret2`. Knowing a site id alone, and site ids leak in the DirectLine token's `site` claim and in the stream URL, is enough to mint DirectLine tokens for that bot. The inline `TODO` at `:62` acknowledges the missing validation.
- WebChat site secrets are stored in plaintext (`webchat.service.ts:126-127`), so a database read discloses live credentials.
- `getConversation` (`directline-conversation.service.ts:105-122`) verifies the token but never compares `validPayload.conv` to the `:conversationId` path parameter, then does `atomicOperationService.set(conversationId, Number(watermark))`. Any OBF-issued token can reset the activity watermark of any conversation, and can pass a `NaN` watermark.
- `userReplyToConversation` verifies with `ignoreExpiration: true` (`:146`), so an expired DirectLine token can keep sending user messages indefinitely. Only the WebSocket path enforces expiry.
- The WebSocket handler treats a **missing** `?t=` as success: when `token === null` the `if` at `directline.gateway.ts:32` is skipped entirely, no exception is thrown, and the socket stays open (unregistered, so it receives nothing, but it is never closed). Unauthenticated sockets accumulate.
- `enableCors({ origin: true })` in `src/main.ts:17-20` reflects any requesting origin. Combined with tokens held in browser `localStorage`, there is no origin restriction on the admin API or the DirectLine API.
- `synchronize: true` is set on the TypeORM connection (`src/app.module.ts:51`) alongside migrations, so the schema is auto-mutated at boot.
- Admin identity is a single shared username and password from env. No per-user accounts, no audit trail, no rotation, no lockout, and no rate limiting on `POST /api/login`.
- `plainReducted` stores the first 3 characters of every bot API secret in cleartext, shrinking the brute-force space for anyone with database read access.
