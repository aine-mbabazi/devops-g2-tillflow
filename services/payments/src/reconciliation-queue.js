// Producer and consumer for devops-g2-reconciliation (infra/main/sqs.tf).
//
// A message is enqueued the moment a Daraja dispatch is unconfirmed — the
// `provider_dispatch_unconfirmed` sites in app.js. It is the automated
// replacement for a person reading that log line and re-querying Daraja by
// hand (see ADR 0004).
//
// Reconciliation order (docs/runbook.md): Daraja is the source of truth, and
// a payment/payout leaves `pending` only when a provider query returns a
// terminal result — never by inferring an outcome from a timeout. That rule
// is what processMessage below encodes.

export function createReconciliationQueue({ queueClient, queueUrl, log }) {
  async function enqueue(message) {
    try {
      await queueClient.sendMessage({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message) });
    } catch (error) {
      // Not fatal: the payment/payout is already durably recorded as pending.
      // Losing this message just means the queue-age alarm never sees it and
      // a human falls back to the provider_dispatch_unconfirmed log line —
      // the exact path this queue exists to replace, not a new failure mode.
      log({ event: 'reconciliation_enqueue_failed', ...message, code: error.code ?? 'UNKNOWN' });
    }
  }

  // Returns true when the message is resolved and safe to delete, false when
  // it should be left for SQS to redeliver (and, after five receives, DLQ).
  async function processMessage(body, { paymentStore, payoutStore, darajaClient }) {
    const isPayout = body.type === 'payout';
    const store = isPayout ? payoutStore : paymentStore;
    const record = await store.findById(body.id);
    // Gone or already terminal: transitioning an already-terminal record is a
    // no-op everywhere else in this codebase, and at-least-once delivery
    // means this message may simply be a duplicate of one already handled.
    if (!record || record.status !== 'pending') return true;
    // The initial dispatch never got a provider ID back, so there is nothing
    // to query yet. This is exactly the case the DLQ exists for: after five
    // receives it lands there for a human to resolve, per
    // docs/runbook.md#reconciliation-dlq.
    if (!record.providerRequestId) return false;
    const verified = isPayout
      ? await darajaClient.queryB2C(record.providerRequestId)
      : await darajaClient.queryPayment(record.providerRequestId);
    if (!['succeeded', 'failed'].includes(verified.status)) return false;
    await store.transition(record.id, verified.status);
    log({ event: 'reconciled', type: body.type, id: record.id, status: verified.status });
    return true;
  }

  async function pollOnce({ paymentStore, payoutStore, darajaClient }) {
    const { Messages = [] } = await queueClient.receiveMessage({
      QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20,
    });
    for (const message of Messages) {
      let resolved = false;
      try {
        resolved = await processMessage(JSON.parse(message.Body), { paymentStore, payoutStore, darajaClient });
      } catch (error) {
        // A query failure (Daraja unavailable, transport timeout) leaves the
        // message in place for redelivery — never inferred as an outcome.
        log({ event: 'reconciliation_message_failed', code: error.code ?? 'UNKNOWN' });
      }
      if (resolved) await queueClient.deleteMessage({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle });
    }
    return Messages.length;
  }

  async function run({ paymentStore, payoutStore, darajaClient, signal }) {
    while (!signal.aborted) {
      try {
        await pollOnce({ paymentStore, payoutStore, darajaClient });
      } catch (error) {
        // A receive/delete call itself failing (queue unreachable) must not
        // kill the loop — back off and try again on the next long poll.
        log({ event: 'reconciliation_poll_failed', code: error.code ?? 'UNKNOWN' });
      }
    }
  }

  return { enqueue, processMessage, pollOnce, run };
}
