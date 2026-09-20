import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';

// Thin adapter over the AWS SDK so reconciliation-queue.js depends on three
// plain methods it can also get from a fake in tests, never on the SDK
// directly.
export function createSqsQueueClient({ region } = {}) {
  const client = new SQSClient({ region });
  return {
    sendMessage: (input) => client.send(new SendMessageCommand(input)),
    receiveMessage: (input) => client.send(new ReceiveMessageCommand(input)),
    deleteMessage: (input) => client.send(new DeleteMessageCommand(input)),
  };
}
