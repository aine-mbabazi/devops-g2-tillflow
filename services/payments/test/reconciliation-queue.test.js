import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createReconciliationQueue } from '../src/reconciliation-queue.js';
import { FakeDarajaClient } from '../src/daraja/fake-client.js';
import { InMemoryPaymentStore } from '../src/payment-store.js';
import { InMemoryPayoutStore } from '../src/payout-store.js';

// A fake SQS in place of the real service, mirroring FakeDarajaClient: no
// network, deterministic, and just enough of the three-method surface
// reconciliation-queue.js actually calls.
function fakeQueueClient() {
  const messages = [];
  return {
    sent: [],
    async sendMessage({ MessageBody }) {
      this.sent.push(JSON.parse(MessageBody));
      messages.push({ MessageId: randomUUID(), ReceiptHandle: randomUUID(), Body: MessageBody });
    },
    async receiveMessage() {
      const batch = messages.splice(0, 10);
      return { Messages: batch };
    },
    async deleteMessage({ ReceiptHandle }) {
      this.deleted ??= [];
      this.deleted.push(ReceiptHandle);
    },
    // Test-only: put a message straight on the queue without going through
    // enqueue(), for cases where the message describes a record's state
    // before a real dispatch would have produced it.
    push(body) { messages.push({ MessageId: randomUUID(), ReceiptHandle: randomUUID(), Body: JSON.stringify(body) }); },
  };
}

test('enqueue sends a message describing the unconfirmed payment or payout', async () => {
  const queueClient = fakeQueueClient();
  const entries = [];
  const queue = createReconciliationQueue({ queueClient, queueUrl: 'https://sqs.example/q', log: (e) => entries.push(e) });
  await queue.enqueue({ type: 'payment', id: 'payment_1' });
  await queue.enqueue({ type: 'payout', id: 'payout_1' });
  assert.deepEqual(queueClient.sent, [{ type: 'payment', id: 'payment_1' }, { type: 'payout', id: 'payout_1' }]);
});

test('enqueue failure is logged, never thrown — the payment is already durably pending', async () => {
  const queueClient = { sendMessage: async () => { const e = new Error('down'); e.code = 'SQS_UNAVAILABLE'; throw e; } };
  const entries = [];
  const queue = createReconciliationQueue({ queueClient, queueUrl: 'https://sqs.example/q', log: (e) => entries.push(e) });
  await queue.enqueue({ type: 'payment', id: 'payment_1' });
  assert.equal(entries[0].event, 'reconciliation_enqueue_failed');
  assert.equal(entries[0].code, 'SQS_UNAVAILABLE');
});

async function seedPendingPayment(darajaClient, paymentStore, { attachProvider = true } = {}) {
  const { kind, payment } = paymentStore.createOrGet({
    tenantId: 't1', idempotencyKey: 'k1', fingerprint: 'f1', saleId: 's1',
    amountMinor: 10000, currency: 'KES', customerPhone: '+254700000001',
  });
  assert.equal(kind, 'created');
  if (attachProvider) {
    const { providerRequestId } = await darajaClient.initiateStkPush({ amountMinor: 10000, currency: 'KES', phone: '+254700000001' });
    paymentStore.attachProviderRequest(payment.id, providerRequestId);
    return { ...payment, providerRequestId };
  }
  return payment;
}

test('a payment resolved succeeded by Daraja is transitioned and its message deleted', async () => {
  const queueClient = fakeQueueClient();
  const darajaClient = new FakeDarajaClient();
  const paymentStore = new InMemoryPaymentStore();
  const payoutStore = new InMemoryPayoutStore();
  const entries = [];
  const queue = createReconciliationQueue({ queueClient, queueUrl: 'q', log: (e) => entries.push(e) });

  const payment = await seedPendingPayment(darajaClient, paymentStore);
  darajaClient.simulateOutcome(payment.providerRequestId, 'succeeded');
  await queue.enqueue({ type: 'payment', id: payment.id });

  const processed = await queue.pollOnce({ paymentStore, payoutStore, darajaClient });
  assert.equal(processed, 1);
  assert.equal(paymentStore.findById(payment.id).status, 'succeeded');
  assert.equal(queueClient.deleted.length, 1);
  assert.ok(entries.some((e) => e.event === 'reconciled' && e.id === payment.id && e.status === 'succeeded'));
});

test('a payment still pending at Daraja is left on the queue for redelivery', async () => {
  const queueClient = fakeQueueClient();
  const darajaClient = new FakeDarajaClient();
  const paymentStore = new InMemoryPaymentStore();
  const payoutStore = new InMemoryPayoutStore();
  const queue = createReconciliationQueue({ queueClient, queueUrl: 'q', log: () => {} });

  const payment = await seedPendingPayment(darajaClient, paymentStore);
  await queue.enqueue({ type: 'payment', id: payment.id });

  await queue.pollOnce({ paymentStore, payoutStore, darajaClient });
  assert.equal(paymentStore.findById(payment.id).status, 'pending');
  assert.equal(queueClient.deleted, undefined);
});

test('a payment with no provider request ID (dispatch never confirmed) is left for the DLQ, not queried', async () => {
  const queueClient = fakeQueueClient();
  const darajaClient = new FakeDarajaClient();
  darajaClient.queryPayment = async () => { throw new Error('must not be called without a provider request ID'); };
  const paymentStore = new InMemoryPaymentStore();
  const payoutStore = new InMemoryPayoutStore();
  const queue = createReconciliationQueue({ queueClient, queueUrl: 'q', log: () => {} });

  const payment = await seedPendingPayment(darajaClient, paymentStore, { attachProvider: false });
  await queue.enqueue({ type: 'payment', id: payment.id });

  await queue.pollOnce({ paymentStore, payoutStore, darajaClient });
  assert.equal(paymentStore.findById(payment.id).status, 'pending');
  assert.equal(queueClient.deleted, undefined);
});

test('an already-terminal payment is a no-op — the message is deleted without a second query', async () => {
  const queueClient = fakeQueueClient();
  const darajaClient = new FakeDarajaClient();
  darajaClient.queryPayment = async () => { throw new Error('must not query an already-terminal payment'); };
  const paymentStore = new InMemoryPaymentStore();
  const payoutStore = new InMemoryPayoutStore();
  const queue = createReconciliationQueue({ queueClient, queueUrl: 'q', log: () => {} });

  const payment = await seedPendingPayment(new FakeDarajaClient(), paymentStore);
  paymentStore.transition(payment.id, 'succeeded');
  await queue.enqueue({ type: 'payment', id: payment.id });

  const processed = await queue.pollOnce({ paymentStore, payoutStore, darajaClient });
  assert.equal(processed, 1);
  assert.equal(queueClient.deleted.length, 1);
});

test('a Daraja query failure during reconciliation leaves the message for redelivery and does not throw', async () => {
  const queueClient = fakeQueueClient();
  const darajaClient = new FakeDarajaClient();
  darajaClient.queryPayment = async () => { const e = new Error('timeout'); e.code = 'DARAJA_TIMEOUT'; throw e; };
  const paymentStore = new InMemoryPaymentStore();
  const payoutStore = new InMemoryPayoutStore();
  const entries = [];
  const queue = createReconciliationQueue({ queueClient, queueUrl: 'q', log: (e) => entries.push(e) });

  const payment = await seedPendingPayment(new FakeDarajaClient(), paymentStore);
  paymentStore.attachProviderRequest(payment.id, 'fake-cr-1');
  await queue.enqueue({ type: 'payment', id: payment.id });

  await assert.doesNotReject(queue.pollOnce({ paymentStore, payoutStore, darajaClient }));
  assert.equal(paymentStore.findById(payment.id).status, 'pending');
  assert.equal(queueClient.deleted, undefined);
  assert.ok(entries.some((e) => e.event === 'reconciliation_message_failed' && e.code === 'DARAJA_TIMEOUT'));
});

test('a payout is reconciled through queryB2C, same as a payment through queryPayment', async () => {
  const queueClient = fakeQueueClient();
  const darajaClient = new FakeDarajaClient();
  const paymentStore = new InMemoryPaymentStore();
  const payoutStore = new InMemoryPayoutStore();
  const queue = createReconciliationQueue({ queueClient, queueUrl: 'q', log: () => {} });

  const { payout } = payoutStore.createOrGet({
    tenantId: 't1', idempotencyKey: 'k1', fingerprint: 'f1', attendantId: 'a1', commissionRunId: 'run1',
    amountMinor: 2500, currency: 'KES', recipientPhone: '+254700000002',
  });
  const { providerRequestId } = await darajaClient.initiateB2C({ amountMinor: 2500, currency: 'KES', phone: '+254700000002' });
  payoutStore.attachProviderRequest(payout.id, providerRequestId);
  darajaClient.simulateOutcome(providerRequestId, 'failed');
  await queue.enqueue({ type: 'payout', id: payout.id });

  await queue.pollOnce({ paymentStore, payoutStore, darajaClient });
  assert.equal(payoutStore.findById(payout.id).status, 'failed');
});

test('run() polls until its signal is aborted', async () => {
  const queueClient = fakeQueueClient();
  const darajaClient = new FakeDarajaClient();
  const paymentStore = new InMemoryPaymentStore();
  const payoutStore = new InMemoryPayoutStore();
  const queue = createReconciliationQueue({ queueClient, queueUrl: 'q', log: () => {} });

  const controller = new AbortController();
  let calls = 0;
  const originalReceive = queueClient.receiveMessage.bind(queueClient);
  queueClient.receiveMessage = async (input) => {
    calls += 1;
    if (calls >= 3) controller.abort();
    return originalReceive(input);
  };

  await queue.run({ paymentStore, payoutStore, darajaClient, signal: controller.signal });
  assert.ok(calls >= 3);
});
