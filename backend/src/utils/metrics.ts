import client from "prom-client";
import { pool } from "../db/client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsInFlight = new client.Gauge({
  name: "http_requests_in_flight",
  help: "Number of HTTP requests currently being processed",
  registers: [registry],
});

// Sampled on each /metrics scrape rather than kept as a live gauge - pg.Pool
// exposes these counts synchronously, so there's nothing to update on an
// interval.
new client.Gauge({
  name: "pg_pool_total_count",
  help: "Total number of clients in the Postgres pool",
  collect() {
    this.set(pool.totalCount);
  },
  registers: [registry],
});

new client.Gauge({
  name: "pg_pool_idle_count",
  help: "Number of idle clients in the Postgres pool",
  collect() {
    this.set(pool.idleCount);
  },
  registers: [registry],
});

new client.Gauge({
  name: "pg_pool_waiting_count",
  help: "Number of queued requests waiting for a Postgres client",
  collect() {
    this.set(pool.waitingCount);
  },
  registers: [registry],
});
