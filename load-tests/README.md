# OBF load and robustness tests (JMeter)

Two Apache JMeter plans for the Open Bot Framework DirectLine 3.0 gateway:

- `obf-load.jmx` — load and soak. Each virtual user gets a token, starts a
  conversation, opens the WebSocket, sends N messages and waits for each bot
  reply, then closes. Records send-to-reply latency as its own sample.
- `obf-hostile.jmx` — robustness. One user fires malformed, unauthorized and
  oversized requests and asserts each gets the exact 4xx the gateway returns,
  never a 5xx, never a hang.

Every setting is a `-J` property with a default. No secrets or targets are
hardcoded. You point the plans at your own deployment.

## Install

1. JMeter **5.6.3** (the plans declare this version in their header; use 5.6.3
   or newer). Download from <https://jmeter.apache.org/download_jmeter.cgi>, unpack, and
   make sure `bin/jmeter` is on your PATH.
2. WebSocket support: **"WebSocket Samplers by Peter Doornbosch"**. Install the
   latest version through the JMeter Plugins Manager:
   - Put `jmeter-plugins-manager-*.jar` in `lib/ext/`, restart JMeter.
   - Options -> Plugins Manager -> Available Plugins -> tick "WebSocket
     Samplers" -> Apply Changes and Restart.
   The plans use these sampler classes from it: `OpenWebSocketSampler`,
   `SingleReadWebSocketSampler`, `CloseWebSocketSampler`, `TextFrameFilter`.
   Record the exact plugin version you installed here after the first local
   run: `__________`.
3. For the >1 MiB body probe in `obf-hostile.jmx`, no extra plugin is needed
   (it builds the body in a Groovy preprocessor, which ships with JMeter).

## Run

Non-GUI, with an HTML report:

```bash
jmeter -n -t obf-load.jmx \
  -JHOST=your-obf-host -JPORT=1986 \
  -JWS_HOST=your-obf-host -JWS_PORT=1992 \
  -JWEBCHAT_SECRET=... \
  -JUSERS=50 -JRAMP_UP=30 -JDURATION=600 \
  -l results/load.jtl -e -o report/load
```

```bash
jmeter -n -t obf-hostile.jmx \
  -JHOST=your-obf-host -JPORT=1986 \
  -JWS_HOST=your-obf-host -JWS_PORT=1992 \
  -JWEBCHAT_SECRET=... \
  -l results/hostile.jtl -e -o report/hostile
```

Open `report/<name>/index.html` for the HTML report. `results/` and `report/`
are gitignored.

Edit in the GUI with `jmeter -t obf-load.jmx` (no `-n`). Do not run load from
the GUI; it skews numbers.

## Properties

Both plans:

| Property | Default | Meaning |
|---|---|---|
| `PROTOCOL` | `http` | `http` or `https` for the REST port |
| `HOST` | `localhost` | OBF REST host |
| `PORT` | `1986` | OBF REST port |
| `WS_HOST` | = `HOST` | OBF WebSocket host |
| `WS_PORT` | `1992` | OBF WebSocket port (`SOCKET_PORT`) |
| `WS_TLS` | `false` | `true` for `wss://` |
| `WEBCHAT_SECRET` | (empty) | DirectLine site secret, `site.secret` form |
| `CONNECT_TIMEOUT_MS` | `5000` | TCP/WS connect timeout |

`obf-load.jmx` only:

| Property | Default | Meaning |
|---|---|---|
| `USERS` | `10` | concurrent virtual users |
| `RAMP_UP` | `10` | seconds to start all users |
| `DURATION` | `60` | seconds to run |
| `MESSAGES` | `3` | messages per conversation |
| `MESSAGE_TEXT` | `hello` | text sent each turn |
| `CHANNEL_DATA` | `{}` | JSON merged into each activity's `channelData` |
| `THINK_MS` | `1000` | pause between messages |
| `REPLY_TIMEOUT_MS` | `15000` | max wait for a bot reply |

`obf-hostile.jmx` only:

| Property | Default | Meaning |
|---|---|---|
| `BAD_TOKEN` | a malformed JWT | token used for the invalid-token probes |
| `OVERSIZE_BYTES` | `1200000` | size of the over-1-MiB body probe |
| `RESPONSE_TIMEOUT_MS` | `20000` | HTTP response timeout |
| `MAX_MS` | `15000` | a sampler slower than this fails the "never hang" check |

## Example property sets

Load:

```
-JUSERS=50 -JRAMP_UP=30 -JDURATION=600 -JMESSAGES=5 -JTHINK_MS=1000
```

Spike (fast ramp, short):

```
-JUSERS=200 -JRAMP_UP=5 -JDURATION=120 -JMESSAGES=3 -JTHINK_MS=200
```

Soak (low load, long):

```
-JUSERS=20 -JRAMP_UP=60 -JDURATION=14400 -JMESSAGES=1000 -JTHINK_MS=3000
```

## Reading the HTML report

- **APDEX** and the **Statistics** table at the top: start here. For `obf-load`,
  the sample named `Round trip: send message to bot reply` is the real
  send-to-reply latency. The raw `04 Send message` sample is only the POST
  acknowledgement, not the reply.
- **Response Times Over Time** and **Active Threads Over Time** (under Charts):
  watch for latency climbing as users ramp. A flat line that then spikes is
  where the gateway or bot saturates.
- **Errors** table: for `obf-hostile`, this should be empty. Any row here means
  a probe did not get its expected 4xx, or the gateway returned a 5xx or hung.

## The bot behind OBF caps everything

OBF forwards each message to a real hbf-bot flow and waits up to 5s for it.

- **An LLM flow will cap your throughput and cost money.** Each message is a
  model call. Point the tests at a scripted, no-LLM flow (a flow that echoes or
  returns a fixed answer) unless you are specifically measuring an LLM flow.
- A slow or failing bot shows up as high `Round trip` latency, or as a `400`
  with body `Failed to post to bot endpoint` (OBF reports an upstream failure
  as 400, not 502 — see below).

## Known OBF responses the hostile plan does NOT assert

Reading the OBF source turned up cases that currently return **500** or behave
oddly. A robustness plan should surface these as bugs, not bake them into
assertions, so they are left out of `obf-hostile.jmx`. Fix them before
production, then add assertions:

1. Upload with `Content-Type: multipart/form-data` and no `boundary=` returns
   **500** (busboy throws a plain error that is rethrown).
2. `GET /conversations/{id}?watermark=99999999999999999999` then the next
   activity returns **500** on the Redis backend (counter overflows int64).
   Any client can also rewind the watermark and cause duplicate activity IDs.
3. Per-conversation rate limits (activities 20/min, uploads 5/min) are keyed on
   the URL conversation ID and checked before auth, so an unauthenticated
   caller can burn another conversation's budget.
4. `TRUST_PROXY_HOPS=1` with no proxy in front lets a spoofed
   `X-Forwarded-For` bypass the per-IP token limit. Rate-limit counters are
   per process, so they do not hold across replicas.
5. Bot failure or timeout is reported to the client as **400**, not a 5xx.
6. WebSocket: no connection cap, a replaced socket for the same conversation is
   never closed, no heartbeat, token expiry is not enforced after connect, and
   inbound frames up to 100 MiB are accepted.
7. Upload has no MIME allowlist; the client's content type is stored as the S3
   object's `Content-Type`.

## Rate limits to keep in mind when sizing a run

Defaults, per 60s, in-process per replica:

- token generate / refresh / start conversation: 30/min, keyed per client IP
  (each route counts separately). Env: `RATE_LIMIT_TOKENS_PER_MINUTE`.
- post activity: 20/min, keyed per conversation ID.
  Env: `RATE_LIMIT_MESSAGES_PER_MINUTE`.
- upload: 5/min, keyed per conversation ID.
  Env: `RATE_LIMIT_UPLOADS_PER_MINUTE`.

A load run with many messages per conversation will hit the 20/min activity
limit and start getting 429s. For throughput tests, raise the limits on the
test environment or use more conversations with fewer messages each.

## Distributed / high load

A single JMeter host caps out well before a real production target. For large
runs, use JMeter distributed mode (one controller, several workers):
<https://jmeter.apache.org/usermanual/remote-test.html>. Picking production
targets and running real load is out of scope for these files.
