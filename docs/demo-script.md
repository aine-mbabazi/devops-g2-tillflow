# Demo script

Walks one tenant from setup through a completed sale, payment, and commission
claim. Assumes AWS credentials and reachability to the internal ALB (see
"Reaching the ALB" at the end).

## 0. Helper - signed service-auth header

POS and Commission authenticate each other with an HMAC token signed over
`<tenantId>.<timestamp>`. Define these once per shell session:

```bash
export SERVICE_AUTH_SECRET="$(aws secretsmanager get-secret-value \
  --secret-id devops-g2/service-auth-secret \
  --region us-east-2 --query SecretString --output text)"

pos_auth() {
  node -e '
    const { createHmac } = require("node:crypto");
    const [tenant, secret] = process.argv.slice(1);
    const ts = String(Date.now());
    const sig = createHmac("sha256", secret).update(tenant + "." + ts).digest("hex");
    process.stdout.write(tenant + "." + ts + "." + sig);
  ' "$1" "$SERVICE_AUTH_SECRET"
}

new_uuid() {
  node -e 'process.stdout.write(require("node:crypto").randomUUID())'
}

export ALB="http://$(terraform -chdir=infra/main output -raw alb_dns_name)"
```

## 1. Tenant setup - attendants and commission rate

```bash
TENANT="tenant-demo-001"
AUTH="$(pos_auth "$TENANT")"

curl -sS -X PUT "$ALB/tenants/$TENANT/config" \
  -H "x-service-auth: $AUTH" \
  -H "content-type: application/json" \
  -d '{
    "commission_rate_basis_points": 250,
    "attendants": [{ "attendant_id": "att-001", "phone": "+254712345678" }]
  }' | jq .
```

Expected: 200 with `commission_rate_basis_points: 250` and one attendant.

## 2. Sale - line items in integer minor units

```bash
SALE_KEY="$(new_uuid)"

SALE_ID="$(curl -sS -X POST "$ALB/sales" \
  -H "x-service-auth: $AUTH" \
  -H "content-type: application/json" \
  -H "idempotency-key: $SALE_KEY" \
  -d "{
    \"tenant_id\": \"$TENANT\",
    \"attendant_id\": \"att-001\",
    \"currency\": \"KES\",
    \"customer_phone\": \"+254712345678\",
    \"line_items\": [
      { \"description\": \"Bread 400g\", \"quantity\": 2, \"unit_price_minor\": 6500 },
      { \"description\": \"Milk 500ml\", \"quantity\": 1, \"unit_price_minor\": 5500 }
    ]
  }" | jq -r .id)"

echo "SALE_ID=$SALE_ID"
```

Expected: 201, `amount_minor: 18500` (2x6500 + 1x5500), `status: "pending"`.

## 3. Duplicate sale - the exactly-once guarantee

Replay step 2 with the same `idempotency-key`. Expected: 200 (not 201), the
same `SALE_ID`, and no second row.

## 4. Pay - hand the sale to Payments

```bash
curl -sS -X POST "$ALB/sales/$SALE_ID/pay" \
  -H "x-service-auth: $AUTH" | jq .
```

Expected: 202 with `payment_id` populated. POS uses the sale's own ID as the
idempotency key to Payments, so a retry cannot dispatch a second STK push.

## 5. Reconcile - confirm the payment

Reconciliation is a pull, not a webhook. Re-run until the sale flips to `paid`:

```bash
curl -sS -X POST "$ALB/sales/$SALE_ID/reconcile" \
  -H "x-service-auth: $AUTH" | jq .
```

Expected after the payment succeeds: `status: "paid"`. The sale is only marked
paid when Payments' record of tenant, sale, amount and currency matches POS's
own record exactly.

## 6. Commission claim

The Commission worker lists confirmed sales for a run, then claims them so a
replay cannot double-pay:

```bash
RUN="run-$(date +%F)"

curl -sS "$ALB/sales?status=paid&commission_run_id=$RUN" \
  -H "x-service-auth: $AUTH" | jq .

curl -sS -X POST "$ALB/sales/claim" \
  -H "x-service-auth: $AUTH" \
  -H "content-type: application/json" \
  -d "{\"commission_run_id\":\"$RUN\",\"sale_ids\":[\"$SALE_ID\"]}"
```

Expected: first command lists the sale; second returns 204. Re-running the
claim is a no-op.

## Reaching the ALB

The ALB is internal-only. Run the demo from a host inside the VPC (SSM Session
on an EC2 instance, or a bastion). Get the URL with:

```bash
terraform -chdir=infra/main output -raw alb_dns_name
```

Public access via API Gateway + VPC Link is planned for G3.
