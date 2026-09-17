# POS span tree and telemetry

What POS actually emits, and how to find it. The ADOT sidecar forwards OTLP
traces to X-Ray (and metrics to CloudWatch EMF) using the collector config in
`infra/main/adot-config.yaml`.

## Bootstrap

Two files load before the application:

- `services/pos/src/register.js` registers the ESM instrumentation hook. Without
  it, `import { createServer } from 'node:http'` binds the unpatched function
  before the SDK can wrap it, and no HTTP span is produced.
- `services/pos/src/telemetry.js` starts the `NodeSDK` with the OTLP HTTP
  exporter, the X-Ray id generator, and the X-Ray propagator.

The Dockerfile `CMD` loads them in order via `node --import`, so both run before
`src/server.js` is evaluated.

## Span tree
```
POST /sales (http.server, auto-instrumented)
├── pg.query INSERT ... ON CONFLICT (pg, auto-instrumented)
└── pg.query SELECT ... (only on the idempotent-retry path)

POST /sales/:id/pay (http.server)
├── pg.query SELECT sale
├── http.client POST /payments (outbound; the trace continues into Payments)
└── pg.query UPDATE sale.payment_id

POST /sales/:id/reconcile (http.server)
├── pg.query SELECT sale
├── http.client GET /payments/:id
└── pg.query UPDATE sale.status (only when the payment matches exactly)

POST /sales/claim (http.server)
└── pg.query UPDATE sales.commission_run_id

GET /sales?status=paid (http.server)
└── pg.query SELECT ... WHERE status='paid'

PUT /tenants/:id/config (http.server)
└── pg.query upsert tenant config

text

`/health` and `/ready` are excluded from tracing via
`ignoreIncomingRequestHook` — polling them would otherwise dominate every
trace view without adding signal.
```

## Attributes on the root span

The auto-instrumentation supplies the standard HTTP attributes
(`http.method`, `http.route`, `http.status_code`, `http.target`). The service
adds its own via the log lines rather than the span, so a log entry always
carries the identifiers a reviewer needs:

| Field | Source | Meaning |
|---|---|---|
| `trace_id` | `traceContext()` | 32-hex X-Ray-compatible trace id |
| `span_id` | `traceContext()` | 16-hex span id |
| `event` | caller | e.g. `http_request`, `reconcile_mismatch` |
| `route` | `describeRoute()` | normalised route, not the raw URL |
| `statusCode` | caller | response status |

Outside a span, `traceContext()` returns `{}` so log lines stay valid JSON.

## Cross-service trace continuity

POS uses the X-Ray propagator, so `trace_id` is stable across the sale →
payment → callback → reconciliation journey. A reviewer should be able to:

1. Find a `POST /sales/:id/pay` span in X-Ray.
2. Confirm its downstream `POST /payments` client span carries the same
   `trace_id`.
3. Follow that trace into the Payments service where the STK push and callback
   are recorded.

This is the flow the G2 telemetry defence cites; see
`evidence/product-pos/README.md` for the reproduction steps that produce it.

## Known gaps

- **ADOT config is shared with Payments.** `adot-config.yaml` names the
  `TillFlow/payments` namespace and the `/devops-g2/payments` log group, so
  POS metrics currently land in the Payments namespace. Traces are unaffected
  (X-Ray keys on service name), but a per-service config or a shared
  `TillFlow` namespace is the follow-up.
- **No Grafana dashboard yet.** The panels (uptime 5m/1h/28d, SLO burn, RED,
  saturation) are a G3 deliverable.
- **No metric emission from POS.** Only traces are exported. The business
  signal counters (`pos_sale_writes_total{outcome=...}`) that the SLO needs
  are not emitted yet.
