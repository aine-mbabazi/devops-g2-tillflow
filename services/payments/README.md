# Payments service

Initial local scaffold owned by @cheshari-pearl. Uses JavaScript ES modules,
Node.js 20+ and npm, with Node's built-in HTTP server and test runner. This is a
provisional runtime choice for team review; there are no third-party dependencies.

## Run locally

From the repository root:

```bash
cd services/payments
npm start
```

In another terminal:

```bash
curl http://127.0.0.1:3001/health
```

Expected response: `{"service":"payments","status":"ok"}`.
Use `npm run dev` for automatic restarts and `npm test` for the test suite.
No dependency installation, AWS resources, database, or credentials are needed.

## Configuration

| Environment variable | Default | Meaning |
|----------------------|---------|---------|
| `HOST` | `127.0.0.1` | Listen address; use `0.0.0.0` when containerizing |
| `PORT` | `3001` | Integer from 1 to 65535 |
| `DARAJA_MODE` | `fake` | Only supported adapter mode in this scaffold |

For example: `PORT=3100 npm start`. Configuration comes from the process
environment; `.env` files are not loaded automatically. Invalid configuration
exits with a nonzero status. SIGINT/SIGTERM stop the server, allowing up to ten
seconds for existing connections to close.

## Scope and extension points

- `src/app.js`: server factory; `GET /health` and `HEAD /health` are liveness
  checks only. They do not claim database or Daraja readiness. Other routes
  return `404`; unsupported health methods return `405`.
- `POST /payments`: accepts a local payment attempt and requires an
  `Idempotency-Key` header plus `tenant_id`, `sale_id`, `amount_minor`, `KES`,
  and a normalized sandbox test phone. `GET /payments/{payment_id}` returns
  the payment's current status.
- `src/config.js`: validates runtime configuration.
- `src/server.js`: wires dependencies, emits JSON logs, and handles shutdown.
  Request logs contain fixed route labels and status codes, not request bodies,
  headers, query strings, or customer identifiers.
- `src/daraja/fake-client.js`: in-memory test double with `initiateStkPush`,
  `queryPayment`, and test-only `simulateOutcome`. Attempts start pending;
  tests explicitly choose success or failure. It makes no network calls and
  does not validate real Daraja phone/amount rules or reproduce its API payloads.

The fake client is instantiated at startup for later handler wiring. It is not
exposed over HTTP; it has no persistence or durable idempotency guarantees.
Use synthetic data only. A fresh instance starts empty.

## Idempotency boundary

The fake Daraja client intentionally does not provide durable idempotency. It
is an in-memory local test double, so its state is lost whenever the service
restarts.

The API now enforces these rules through an in-memory store: an identical retry
returns the same payment attempt, a reused key with changed input returns
`409`, and a second pending or successful payment for one tenant sale returns
`409`. The store is erased on restart; a PostgreSQL repository must enforce the
same constraints durably.

Next work: service authentication and tenant authorization, PostgreSQL
migrations, Daraja **sandbox** integration, callbacks, reconciliation, B2C,
telemetry, and container packaging. No real-money mode is included.
