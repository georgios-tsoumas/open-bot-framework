# Resilience: open-bot-framework

> Error handling and retry patterns for this service.
> Platform-wide patterns: [`docs/architecture/resilience.md`](../../hbf-agentic-framework/docs/architecture/resilience.md)

Verified against `97f9e75` on 2026-08-04.

## HTTP Retry

- **Library:** `@nestjs/axios` `HttpService` (raw axios, no shared retry wrapper — does NOT use `hbf-core-api`).
  No `axios-retry`, no interceptor, no `p-retry`.
- **Attempts:** 1 (no retry)
- **Backoff:** None
- **On failure:** Caught in `userReplyToConversation()` and rethrown as
  `BadRequestException("Failed to post to bot endpoint: ...")`
  (`src/features/directline/directline-conversation.service.ts:173-175`). The failure is visible to the client
  as an HTTP 400 from `POST /v3/directline/conversations/:convId/activities`.

Note the `catch` at `:173` wraps **both** the bot POST and the subsequent
`socketGateway.sendToConversation()` call, so a websocket-delivery failure would also be reported as
"Failed to post to bot endpoint". The upstream error is stringified into the response body, so raw axios error
text (including the bot's internal URL) reaches the caller.

There is also **no rollback** of side effects that already happened before the POST: attachments have been
uploaded to object storage and the activity counter has been incremented
(`directline-conversation.service.ts:153` -> `createActivity` at `:232-256`). A failed bot POST therefore
burns an activity id and leaves orphaned objects in the bucket, and the user's own message is never echoed
onto the websocket because the echo happens only on the success path (`:171`).

## Queue Retry

Not applicable. open-bot-framework has no message queue (no Bull, no BullMQ, no Kafka, no SQS). The
`// Push payload to event endpoint (needs queue)` comment at
`src/features/directline/directline-conversation.service.ts:158` is an acknowledged gap, not an implementation.

## WebSocket Delivery Retry

`DirectLineGateway.sendToConversation()` (`src/features/directline/directline.gateway.ts:68-84`) looks up the
conversation's socket in a process-local map and retries when it is not yet registered (e.g. a client that is
still connecting):

| Attempt | Delay before attempt |
|---------|---------------------|
| 1 | immediate |
| 2 | 1000ms |
| 3 | 2000ms |

Backoff is linear (`1000 * i`), not exponential despite the code comment at `:78`. The loop **also sleeps after
the third failed check** (`i = 3` -> 3000ms) before falling through to the warning, so a bot reply to an
unregistered conversation blocks the caller for a full **6000ms** and only then logs
`Could not send transcript to conversation ...` (`:83`) and drops the transcript. Since
`sendToConversation()` is awaited by both `userReplyToConversation()` (`directline-conversation.service.ts:171`)
and `replyToActivity()` (`:219`), that 6s is added directly to the HTTP request latency of the calling service.

After the three attempts the transcript is **dropped with only a warning**. There is no persistence, no
buffering, and no replay, so the bot's reply is silently lost.

Two further weaknesses on this path:

- **No `readyState` check before `send()`** (`directline.gateway.ts:74`). A stale socket entry (client gone but
  map not cleaned) is treated as live: `ws.send()` on a closed socket surfaces only as a logged error from the
  `ws.on('error')` handler at `:48-50`, and `sendToConversation` returns as if delivery succeeded. No retry
  and no fallback fire in that case.
- **The socket map is never pruned.** There is no `ws.on('close')` handler anywhere in the gateway, so
  `socketMeta` (`:13`) accumulates one entry per conversation for the process lifetime and holds dead
  `WebSocket` objects indefinitely.

## Timeouts

| Call | Timeout | Configured in |
|------|---------|--------------|
| Bot endpoint POST (activity forwarding) | 5000ms | `src/features/directline/directline-conversation.service.ts:163` (explicit per-call `timeout`; axios has no default) |
| Redis connect (atomic counters) | 2000ms | `src/features/atomicity/atomic-operations.provider.ts:26` (`connectTimeout`) |
| Redis commands | **None**; ioredis defaults apply (`maxRetriesPerRequest: 20`, offline queue on) — no `commandTimeout` is set | `src/features/atomicity/atomic-operations.provider.ts:24-27` |
| Object storage upload (MinIO client, S3-compatible — not the AWS SDK) | **None** | `src/features/storage/storage.service.ts:76` — `client.putObject` with no timeout, and no timeout on the `MinioClient` constructed at `:29-37` |
| TypeORM connect / query | **None** | `src/app.module.ts:38-56` — no `connectTimeout`, `acquireTimeout`, `maxQueryExecutionTime`, or pool config |
| `sendToConversation` (aggregate blocking time when the socket is absent) | 6000ms of `setTimeout` sleeps | `src/features/directline/directline.gateway.ts:70-82` |
| WebSocket idle / liveness | **None** — no ping/pong heartbeat, no `terminate()` sweep | `src/features/directline/directline.gateway.ts` |
| Multipart upload | Size-capped at 10MB, not time-capped | `src/main.ts:10-14` |

## Circuit Breakers

**None.** No `opossum`, `cockatiel`, bulkhead, or rate limiter anywhere in `src/`, and no concurrency cap on
outbound bot calls. A slow bot endpoint holds every user-activity request for the full 5s timeout with no
fast-fail once the failure rate is obvious.

## Redis Fallback

`src/features/atomicity/atomic-operations.provider.ts:10-38` selects the atomic counter backend once, at
startup:

1. If `ATOMIC_OPERATIONS_IMPLEMENTATION=memory` or `REDIS_URI` is not set, uses the in-memory backend
   immediately (`:19-22`).
2. Otherwise constructs an ioredis client with `lazyConnect: true, connectTimeout: 2000` and awaits
   `client.connect()` (`:24-30`).
3. On connection failure, logs a warning and falls back to `MemoryAtomicOperationsManager` (`:32-37`).

The in-memory fallback is explicitly labelled development/emergency-only
(`src/features/atomicity/atomic-operations-manager.memory.ts:4-6`). When it is active, activity watermark
counters lose durability and cross-instance consistency: they reset on restart, and two replicas will hand out
**colliding activity ids** for the same conversation. The Redis backend also has a **1-hour TTL** on every
counter key (`atomic-operations-manager.redis.ts:31,46`), so a conversation idle for more than an hour
restarts its numbering from zero.

**The selection is one-shot.** There is no reconnect-and-promote path: if Redis is unavailable at boot the
process stays on the in-memory manager until it is restarted, even after Redis recovers. Conversely, if Redis
goes down *after* a successful boot, every `incr`/`get`/`set` call rejects (after ioredis's default 20 retries
per command) and the error propagates out of `createActivity`, failing the request — there is no runtime
fallback in that direction.

The two implementations also differ in behaviour, not just durability: `MemoryAtomicOperationsManager.get()`
returns `undefined` for an unknown key (`atomic-operations-manager.memory.ts:19-21`) where the Redis one
returns `0` (`atomic-operations-manager.redis.ts:17-23`), so a watermark read on a cold in-memory instance
yields the string `"undefined"` in the transcript payload built at
`directline-conversation.service.ts:211-217`.

## Cache Layer

`CacheModule.register({ isGlobal: true })` (`src/app.module.ts:24`) with no store, i.e. the default in-process
memory store from `@nestjs/cache-manager` 3 / `cache-manager` 7. Two hot lookups use it:

- `OpenBotService.findByHandleCached()` — `src/features/openbot/openbot.service.ts:65-75`
- `WebChatService.findByIdCached()` / `existsByIdCached()` — `src/features/channels/webchat/webchat.service.ts:73,94`

All three pass `10` as the TTL argument. **In `cache-manager` 7 the TTL unit is milliseconds**, not seconds
(`node_modules/cache-manager/README.md:252`, `dist/index.d.ts:72`), so these caches expire after 10ms and are
effectively inert: every activity POST re-queries the bot row, and every token operation re-queries the
webchat site. That is a latency and DB-load issue rather than a correctness one, but it also means the
"minimize DB hits" comment at `openbot.service.ts:56-57` does not hold, and a database outage takes the
DirectLine path down immediately with no warm-cache grace period.

Secondary issue: `existsByIdCached()` keys on the bare site id and `findByHandleCached()` keys on the bare bot
handle, in the same global namespace. A site id equal to a bot handle would cross-contaminate a `boolean` with
an `OpenBot` entity. The 10ms TTL makes a collision unlikely in practice today.

## Exception Handling

A global `AllExceptionsFilter` (`src/filters/exception.filter.ts`, registered at `src/main.ts:16`) catches all
unhandled exceptions on the HTTP path:

- `HttpException` subclasses: status code preserved, message and `getResponse()` surfaced to the caller as
  structured JSON `{ statusCode, timestamp, message, path, description }`.
- Non-HTTP exceptions: status 500, full `String(exception)` as message, logged at `error` level.
- `HttpException` (non-500): logged at `verbose` level only, so 4xx responses are invisible at the default log
  level.

No exceptions are silently swallowed at the controller level. Business-logic errors in services throw NestJS
HTTP exceptions which propagate through the filter.

**The filter does not cover the websocket server.** `DirectLineGateway` runs its own `ws.Server`
(`src/features/directline/directline.gateway.ts:24`), outside Nest's HTTP pipeline. Errors there are handled
locally: an auth failure sends `JSON.stringify({ error: e })` — which serialises a NestJS exception object to
`{}` — and closes the socket (`:42-46`); everything else is logged by the `error` listeners at `:48-50` and
`:57-59`. `wss.on('error')` logs and does not exit, so a failure to bind `SOCKET_PORT` leaves the HTTP service
running with no working websocket transport and no health signal reflecting that.

**Startup is fail-fast for storage config only.** `StorageService`'s constructor throws when
`STORAGE_ENDPOINT` or `STORAGE_BUCKET` is unset (`src/features/storage/storage.service.ts:18-23`), which aborts
DI and crashes the process. Note the checked-in `.env` leaves `STORAGE_ENDPOINT` commented out and
`STORAGE_BUCKET` empty, so an unconfigured deployment crash-loops rather than starting degraded.

## Fallback Strategy

| Failure scenario | Behaviour | User impact |
|-----------------|-----------|------------|
| Bot endpoint unreachable / error / >5s on activity POST | `BadRequestException` thrown, `AllExceptionsFilter` returns 400 with the stringified axios error | User receives an explicit error response. Activity id already consumed and any uploaded attachments left orphaned; the user's own message is not echoed to the socket |
| Bot handle not found in DB | `NotFoundException` from `findByHandleCached` (`openbot.service.ts:72`) | 404 to the caller |
| Redis unreachable at startup | Falls back to in-memory atomic counter manager (`atomic-operations.provider.ts:32-37`) | Watermark counters non-durable; ids collide across replicas; never promoted back to Redis without a restart |
| Redis goes down after startup | Every `incr`/`get`/`set` rejects; error escapes `createActivity` into the global filter as a 500 | Activity creation fails outright — no runtime fallback |
| Redis counter key expires (1h idle) | Counter restarts at 0 (`atomic-operations-manager.redis.ts:31,46`) | Activity ids and watermarks repeat within a long-lived conversation |
| Object storage upload failure | `HttpException` 500 thrown per-file (`storage.service.ts:56-61`), bubbles to the global filter | User receives 500; files already uploaded earlier in the same loop are not cleaned up |
| Storage env vars missing at boot | Constructor throws, DI fails, process exits | Service crash-loops instead of starting without attachment support |
| WebSocket client not connected after 3 attempts (6s) | Transcript dropped, `logger.warn` only (`directline.gateway.ts:83`) | **Bot reply silently lost.** The client receives no error and no message; nothing retries or replays |
| WebSocket entry present but socket already closed | `ws.send()` fails asynchronously, logged by the `error` listener; `sendToConversation` returns as success | Bot reply silently lost, and not even the "could not send" warning is emitted |
| Bot reply arrives on a replica that does not hold the client's socket | Same as "not connected": 6s of retries, then dropped | Bot reply silently lost whenever the deployment has more than one replica |
| Client reconnects after a dropped socket | New socket registered; nothing is replayed | Every activity sent while disconnected is permanently missing from the transcript |
| Invalid/expired DirectLine token | `UnauthorizedException` (`dirtectline-token.service.ts:131-133`) or `BadRequestException` | 401/400 returned to caller. Note the raw JWT error is stringified into the response message |
| Database unreachable | TypeORM query rejects; 500 via the global filter | All DirectLine token and conversation operations fail. The 10ms cache TTL provides no buffer |
| `SOCKET_PORT` already in use | `wss.on('error')` logs the error; the process keeps running | Service reports no failure while no client can stream. Silent, total loss of real-time delivery |

## Real-Time / Multi-Replica Safety

**This service is single-instance by construction.** Three separate pieces of process-local state make a
multi-replica deployment incorrect, not merely suboptimal:

1. **`socketMeta` is a plain `Map<conversationId, WebSocket>`** in the gateway
   (`src/features/directline/directline.gateway.ts:13`). It is not backed by Redis, and there is no pub/sub
   fan-out — ioredis is used *only* for the atomic counters (`grep` finds `ioredis` imports solely in
   `src/features/atomicity/`). Bot-originated replies arrive over HTTP at
   `POST /v3/conversations/:convId/activities` from hbf-bot or a livechat agent
   (`src/features/directline/directline-alt.controller.ts:9-28`) and can land on **any** replica. If that is
   not the replica holding the client's socket, delivery fails: 6s of retries, then a dropped transcript.
2. **The websocket server listens on its own port** (`SOCKET_PORT`, default 1992,
   `directline.gateway.ts:20,24`) rather than sharing the Nest HTTP server. It is a bare `ws.Server`, not a
   Nest gateway, so it bypasses Nest's adapter layer entirely and cannot use any Nest websocket adapter (Redis
   or otherwise). Ingress must route two ports, and sticky affinity on the HTTP port does nothing for the
   socket port.
3. **The in-memory atomic counter fallback** (see [Redis Fallback](#redis-fallback)) hands out colliding
   activity ids across replicas whenever it is active.

Other real-time gaps:

- **No watermark replay — the key DirectLine contract gap.** The DirectLine protocol expects a client to
  reconnect with `?watermark=N` and receive everything after `N`. Here the watermark is only *written*:
  `getConversation()` stores the client-supplied value into the counter
  (`directline-conversation.service.ts:115`) and `replyToActivity()` stamps the current counter onto outgoing
  transcripts (`:211-217`). **Nothing is persisted per conversation** — activities exist only in the request
  that created them — so there is nothing to replay from. A reconnecting client cannot recover missed
  activities. Worse, `getConversation()` lets a client *rewind the server's counter* to any number it supplies,
  which then corrupts subsequent activity ids.
- **No connection-state tracking.** No `close` handler, no `readyState` check, no ping/pong heartbeat, no idle
  reaper. Half-open TCP connections are never detected, so `socketMeta` keeps handing out sockets that will
  never deliver.
- **One socket per conversation, silently.** `socketMeta.set(conv, ws)` (`:39`) overwrites any existing entry.
  A second tab, or a reconnect before the old socket is noticed, evicts the previous one with no notification
  to either side.
- **Unauthenticated sockets stay open.** The auth block is guarded by `if (token !== null)`
  (`directline.gateway.ts:32`). A connection with no `t` query parameter skips verification entirely, is never
  registered, and is **never closed** — it just sits there consuming a file descriptor.
- **CORS is `origin: true`** (reflect any origin) on the HTTP side (`src/main.ts:17-20`); the websocket server
  performs no origin check at all.

## Graceful Shutdown

**There is none.** `src/main.ts` never calls `app.enableShutdownHooks()`, and registers no `SIGTERM`/`SIGINT`
handler (`grep` for `enableShutdownHooks`, `OnApplicationShutdown`, `beforeApplicationShutdown`, and `SIGTERM`
across `src/` returns nothing). Consequences:

- **`DirectLineGateway.onModuleDestroy()` never runs in production.** The `OnModuleDestroy` implementation at
  `src/features/directline/directline.gateway.ts:62-66` is effectively dead code without shutdown hooks
  enabled; the process is killed outright on `SIGTERM`.
- **In-flight conversations are dropped abruptly.** No drain period, no "server going away" frame, no wait for
  outstanding bot POSTs. Every connected websocket client is severed mid-conversation the moment the process
  dies, and any transcript still inside the 6s retry loop is lost.
- Even if the hook *did* run, `wss.close()` (`:64`) only stops the server accepting new connections — the `ws`
  library does not terminate already-established sockets, so it would not drain them either.
- **The Redis client is never quit** and TypeORM's pool is never closed, so connections are dropped rather than
  released.
- **No `HEALTHCHECK` in the Dockerfile** and no healthcheck for the `app` service in `docker-compose.yml` (only
  `postgres` and `redis` have one), so an orchestrator has no signal to stop routing traffic before the kill.

## Health Checks

| Endpoint | Checks |
|----------|--------|
| `GET /health` | Liveness only. Returns `200 {"status":"ok"}` while the process serves HTTP. No auth, no rate limit (`src/features/health/health.controller.ts`) |

There is no readiness endpoint. `/health` does not touch the DB, Redis, or the WebSocket server.

Nothing verifies database connectivity, Redis availability, which atomic-operations backend is actually in use,
whether `SOCKET_PORT` bound successfully, or downstream bot reachability. An instance whose websocket server
failed to bind, or that silently fell back to in-memory counters, is indistinguishable from a healthy one.

## Data Safety

`TypeOrmModule.forRootAsync` sets **`synchronize: true` unconditionally** (`src/app.module.ts:51`) — it is not
gated on `NODE_ENV`. TypeORM will alter the live schema to match the entity classes on every boot, which can
drop columns and tables when an entity changes. In parallel, `migrations` points at
`__dirname + '/../migrations/*.js'` (`:49`) and `migrationsRun` is driven by `TYPEORM_AUTORUN_MIGRATIONS`
(`:50`, set to `true` in the checked-in `.env`) — but **no `migrations/` directory exists in the repo**, so
there is no migration history at all and no reviewable record of schema changes. This is the single largest
data-safety risk in the service.

## Known Gaps

1. **No HTTP retry on bot endpoint calls** (`src/features/directline/directline-conversation.service.ts:160-165`).
   A transient failure forwarding a user activity returns an immediate 400 to the client.
2. **`synchronize: true` with no migrations and no env gate** (`src/app.module.ts:49-51`; no `migrations/`
   directory exists). Schema is mutated automatically at every boot; column removals are destructive and
   unreviewed.
3. **`socketMeta` is process-local, so bot replies are lost in any multi-replica deployment**
   (`src/features/directline/directline.gateway.ts:13,39,71`). No Redis adapter, no pub/sub fan-out.
4. **No watermark replay.** Activities are never persisted per conversation, so a reconnecting client cannot
   recover anything it missed (`directline-conversation.service.ts:115,211-217`). This is the central
   DirectLine-contract gap.
5. **`getConversation()` lets a client rewind the server-side counter** to any value via the `watermark` query
   parameter (`directline-conversation.service.ts:115`), corrupting subsequent activity ids.
6. **WebSocket transcript drops are silent to the end user** (`directline.gateway.ts:83`). The client receives
   no notification that the bot reply was lost; it simply never arrives.
7. **`sendToConversation` blocks the caller for 6s** on a missing socket — three attempts plus a redundant
   trailing 3000ms sleep (`directline.gateway.ts:70-82`) — and that latency sits inside the HTTP request path.
8. **No `readyState` check before `ws.send()`** (`directline.gateway.ts:74`). A stale socket entry makes a
   dropped reply look like a successful delivery, with no warning logged.
9. **`socketMeta` and unauthenticated sockets leak.** No `ws.on('close')` handler exists, and a connection with
   no `t` parameter is neither registered nor closed (`directline.gateway.ts:32-46`).
10. **No websocket heartbeat.** No ping/pong and no idle reaper, so half-open connections are never detected.
11. **Cache TTLs are 10 *milliseconds*, not seconds** (`openbot.service.ts:74`, `webchat.service.ts:73,94`;
    `cache-manager` 7 uses ms). The caches are effectively inert, so every request hits the database.
12. **No timeout on object storage uploads** (`src/features/storage/storage.service.ts:76`). A hung MinIO/S3
    connection stalls activity creation indefinitely; the 10MB-per-file limit is the only bound.
13. **No TypeORM timeouts or pool configuration** (`src/app.module.ts:38-56`). A saturated or hung database
    holds request handlers open with no ceiling.
14. **No Redis `commandTimeout`** (`src/features/atomicity/atomic-operations.provider.ts:24-27`); ioredis's
    default of 20 retries per command applies.
15. **Redis fallback to in-memory is one-shot and never promoted back.** Booting while Redis is down pins the
    process to the non-durable in-memory manager until restart (`atomic-operations.provider.ts:29-37`), where
    activity ids collide across instances.
16. **Redis counters carry a 1-hour TTL** (`atomic-operations-manager.redis.ts:31,46`), so activity ids and
    watermarks restart at 0 in a conversation idle for over an hour.
17. **Memory and Redis counter backends disagree on missing keys** (`undefined` vs `0`), producing the literal
    string `"undefined"` as a watermark on a cold in-memory instance.
18. **Liveness only (`GET /health`), no readiness check.** Orchestrators cannot detect an instance with a dead
    database, a failed `SOCKET_PORT` bind, or a silent in-memory counter fallback. No Dockerfile `HEALTHCHECK`,
    no compose healthcheck on the `app` service.
19. **A `SOCKET_PORT` bind failure is logged and ignored** (`directline.gateway.ts:57-59`). The service stays
    "up" with real-time delivery completely broken.
20. **No graceful shutdown at all.** Shutdown hooks are not enabled and no signal handler exists, so
    `onModuleDestroy` never runs, websocket clients are severed mid-conversation, and DB/Redis connections are
    dropped rather than closed.
21. **No circuit breaker on the bot endpoint.** A slow or failing downstream bot holds every user-activity HTTP
    request for the full 5s timeout, with no fast-fail and no concurrency cap.
22. **No rollback on partial failure.** A failed bot POST leaves the activity counter incremented and uploaded
    attachments orphaned (`directline-conversation.service.ts:153,159-175`), and a mid-loop storage failure
    leaves earlier files of the same request in the bucket (`storage.service.ts:49-62`).
23. **Internal error detail leaks to callers.** Both the axios error (`directline-conversation.service.ts:174`)
    and the raw JWT error (`dirtectline-token.service.ts:132`) are stringified into response messages.
24. **Effectively no test coverage.** The only spec is `src/sanity.spec.ts`, which asserts `true === true`.
    Nothing exercises the retry loop, the Redis fallback, or any failure path above.
