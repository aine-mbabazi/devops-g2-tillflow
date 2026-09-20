# Web service

The `WEB` stage of the required `WEB -> API GATEWAY -> SERVICES` architecture
(`docs/architecture.md`). Owned by @aine-mbabazi per `docs/ownership.md`
("Product + POS + Web"), scoped there as a **frontend / API shell**, not a
full product.

## What this is

A thin, stateless proxy in front of POS and Payments. It owns no money state,
no sale state, and makes no authorization decisions of its own:

- A caller's signed `x-service-auth` token (`services/_shared/service-auth.js`)
  is verified here first, so an invalid or missing token fails fast with a
  clean `401` instead of a confusing error surfaced from a downstream proxy
  call.
- The same header is then forwarded to POS/Payments **unchanged** — web never
  re-signs or re-mints a token. Each downstream service verifies it again
  independently, exactly as it would for a direct caller.

## What this is not

There is no end-user identity layer behind that token. `docs/production-
readiness.md` already discloses this as an accepted product gap ("the web
tier that would carry user identity does not exist"); this service does not
paper over that gap with a second, weaker auth scheme of its own. A real
tenant-facing UI would sit in front of this shell and be responsible for
obtaining a valid service-auth token some other way — that work is out of
scope here.

## Routes

| Route | Forwards to |
|-------|-------------|
| `GET`/`HEAD /health` | liveness only, no dependency |
| `GET`/`HEAD /ready` | `200` only when both POS and Payments `/health` are reachable |
| `POST /sales` | `POST /sales` on POS |
| `GET /sales/:id` | `GET /sales/:id` on POS |
| `POST /sales/:id/pay` | `POST /sales/:id/pay` on POS |
| `GET /payments/:id` | `GET /payments/:id` on Payments |

Every proxied route returns the upstream service's status code and body
verbatim; a downstream network failure is reported as `502
upstream_unavailable`, never a raw exception.

## Run locally

From the repository root, with POS and Payments already running (see their
own READMEs):

```bash
cd services/web
SERVICE_AUTH_SECRET=local-dev-secret npm start
```

```bash
curl http://127.0.0.1:3003/health
```

Expected response: `{"service":"web","status":"ok"}`.

## Configuration

| Environment variable | Default | Meaning |
|----------------------|---------|---------|
| `HOST` | `127.0.0.1` | Listen address; use `0.0.0.0` when containerizing |
| `PORT` | `3003` | Integer from 1 to 65535 |
| `POS_BASE_URL` | `http://127.0.0.1:3002` | Where to reach POS |
| `PAYMENTS_BASE_URL` | `http://127.0.0.1:3001` | Where to reach Payments |
| `SERVICE_AUTH_SECRET` | — | Required always; the same shared HMAC secret POS and Payments verify callers with |

## Tests

`npm test` drives web against real POS and Payments HTTP servers (Payments
backed by the deterministic fake Daraja adapter) through a full
create-sale -> pay -> payment-status flow, plus the auth-rejection and
readiness-degradation paths — not mocked, the same integration-test style
used by the other services.
