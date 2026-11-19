# Multi-instance DirectLine (HAP-645)

Changes originate in `georgios-tsoumas/open-bot-framework`, targeting `develop`.
The Helvia fork synchronizes from that branch after merge. Its deployment pipeline
is maintained in the fork and is not introduced by this change.

## Delivery and replay

All replicas share Redis. Each gateway subscribes to the conversations whose
WebSockets it holds. Bot replies and accepted user echoes are stored and published
atomically; the receiving HTTP replica need not own the client's socket.

Activity IDs remain `<conversationId>|<sequence>`. The sequence is allocated by
Redis with a 24-hour idle TTL; conversation GET never changes it. Delivery order
uses a separate opaque `v2:<Redis stream ID>` watermark, so a delayed lower-ID
activity can still be recovered after reconnect. Clients must retain watermarks
as strings. Typing has no watermark and is not stored.

History is retained for five minutes. Subscription completes before replay starts;
live publications queue during replay and duplicate cursors are suppressed.
Subscriber loss closes sockets with code 1011 to trigger reconnect and replay.
A five-minute per-invocation receipt prevents duplicate publication when Redis
automatically resends an unacknowledged command. It is not HTTP retry idempotency.

Redis keys are the raw conversation ID for the activity counter,
`obf:conv:<id>:stream` for history, and
`obf:conv:<id>:stream:publication:<uuid>` for retry receipts. The
`obf:conv:<id>` channel carries live publications. Legacy sorted-set history at
`obf:conv:<id>:activities` remains readable for numeric reconnect watermarks.
Rate-limit counters are shared under `obf:rl:`.

## Deployment requirements

- Redis >=6.2 and `REDIS_URI` are required. There is no in-memory fallback.
- The first cutover must not mix old numeric-watermark publishers/gateways with
  v2 replicas. Stop old traffic before starting the new version, retain Redis,
  and complete cutover within the five-minute replay window. Subsequent v2-compatible
  releases can roll normally. Existing historical message gaps cannot be repaired.
- Route HTTP on `PORT` (default 1986) and WebSockets on `SOCKET_PORT` (1992 in
  the example configuration). `DIRECTLINE_SOCKET_URL` must route to the socket
  listener, and ingress WebSocket idle timeout must exceed 20 seconds.
- Use `/health` for liveness. It returns 200 while the process serves HTTP and does
  not check Redis, the database or draining. There is no readiness endpoint.
- On shutdown, new sockets are refused before the gateway
  waits `SHUTDOWN_DRAIN_MS` (default 5000), then closes sockets with code 1001.
  The termination grace period must exceed this drain time.
- Schema synchronization is disabled. TypeORM runs pending migrations before
  listening. The baseline supports PostgreSQL and MySQL. Migration execution is
  not serialized across replicas; validate concurrent startup and existing-schema
  compatibility on the target database before release.
- The upstream test workflow does not deploy. Before the fork deploys, configure
  the coordinated cutover and require the regression tests to pass in its pipeline.

## Validation

Run `npm run build` and `OBF_TEST_REDIS_URI=redis://127.0.0.1:6379 npm test -- --runInBand`.
The integration suite runs two independent HTTP/WebSocket applications against
real Redis, using a local bot HTTP endpoint and fixtures for database lookups and
storage. It covers concurrent and delayed publication, reconnect, authorization,
numeric cursor transition, counter expiry, subscriber loss and command resend.

Set `OBF_TEST_DIRECTLINE_MODULE_DIR` to an existing `botframework-directlinejs`
installation to include the optional SDK compatibility test. Without a Redis URI,
the integration suite is skipped; the upstream workflow supplies Redis explicitly.

These tests do not validate a full database-backed application boot, Kubernetes
rollout, production load or the 200ms latency target. The inherited 24-hour counter
expiry can repeat activity IDs, even though delivery cursors continue independently.
