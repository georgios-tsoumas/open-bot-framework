// Elastic APM agent. Must be the first import in main.ts so it can instrument
// http, fastify, pg, ioredis and axios before they are loaded.
// Configured entirely through ELASTIC_APM_* env vars; only started when a server URL is set,
// so local dev and tests do not try to reach an APM server on localhost:8200.
import * as apm from 'elastic-apm-node';

if (process.env.ELASTIC_APM_SERVER_URL && !apm.isStarted()) {
    apm.start();
}
