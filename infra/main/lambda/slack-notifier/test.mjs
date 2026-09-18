// Unit tests for the alert renderer. Run with:
//   node --test infra/main/lambda/slack-notifier/test.mjs
//
// No dependencies and no AWS: buildMessage is a pure function of the alarm
// event, which is why the SDK import in index.mjs is lazy. The alert contract
// is the thing this whole area is judged on, so it is worth asserting rather
// than eyeballing in Slack once and hoping.
//
// Excluded from the deployment zip by the `excludes` argument on
// data.archive_file.slack_notifier.

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMessage, observedValue } from './index.mjs';

const CONTRACT = {
  service: 'payments',
  owner: '@cheshari-pearl',
  symptom: 'Daraja callbacks are taking more than 60s to reach a terminal state (p95).',
  impact: 'Sales stay pending at the till after the customer has paid.',
  unit: 'milliseconds (p95)',
  panel: '',
  runbook: '#payments-callback-lag',
  first_action: 'Run the reconciliation path rather than retrying payments.',
};

function alarmEvent(overrides = {}) {
  return {
    AlarmName: 'devops-g2-payments-callback-lag',
    NewStateValue: 'ALARM',
    NewStateReason: 'Threshold Crossed: 2 datapoints [86000.0 (18/09/26 06:00:00)] were greater than the threshold (60000.0).',
    AlarmDescription: JSON.stringify(CONTRACT),
    StateChangeTime: '2026-09-18T06:05:00.000+0000',
    Trigger: { Threshold: 60000 },
    ...overrides,
  };
}

function textOf(message) {
  return JSON.stringify(message);
}

test('observedValue pulls the datapoint out of CloudWatch prose', () => {
  assert.equal(observedValue('Threshold Crossed: 1 datapoint [7.0 (18/09/26 06:00:00)] was greater than the threshold (1.0).'), '7.0');
  // No bracketed datapoint (e.g. an INSUFFICIENT_DATA transition): the full
  // reason is better than an empty field.
  assert.equal(observedValue('Insufficient Data: 1 datapoint was unknown.'), 'Insufficient Data: 1 datapoint was unknown.');
  assert.equal(observedValue(undefined), 'unknown');
});

test('a firing alert carries every field of the contract', () => {
  const rendered = textOf(buildMessage(alarmEvent()));
  for (const expected of [
    'devops-g2-payments-callback-lag',
    'payments',
    '@cheshari-pearl',
    '86000.0',
    'milliseconds (p95)',
    '60000',
    CONTRACT.symptom,
    CONTRACT.impact,
    CONTRACT.first_action,
    '#payments-callback-lag',
  ]) {
    assert.ok(rendered.includes(expected), `missing from the rendered alert: ${expected}`);
  }
  assert.match(rendered, /FIRING/);
  assert.match(rendered, /#d13212/); // red
});

test('a recovery alert is green, says RECOVERED, and drops the first safe action', () => {
  const message = buildMessage(alarmEvent({ NewStateValue: 'OK' }));
  const rendered = textOf(message);
  assert.match(rendered, /RECOVERED/);
  assert.match(rendered, /#2e7d32/); // green
  // The whole point: acting on an alert that already cleared is noise.
  assert.ok(!rendered.includes(CONTRACT.first_action));
  // But it still says what recovered, and who owns it.
  assert.ok(rendered.includes('@cheshari-pearl'));
});

test('an alarm with no contract still delivers, and shows what is missing', () => {
  // An alarm created in the console, or one whose description was hand-edited.
  const message = buildMessage(alarmEvent({ AlarmDescription: 'CPU is high' }));
  const rendered = textOf(message);
  assert.ok(rendered.includes('CPU is high'), 'a plain-text description becomes the symptom');
  assert.ok(rendered.includes('unassigned'), 'a missing owner is visible, not silently blank');
  assert.ok(rendered.includes('not stated'));
});

test('a malformed alarm event does not throw', () => {
  // SNS will happily deliver something unexpected. Throwing here would make
  // Lambda retry forever and, worse, would drop every other record in the batch.
  assert.doesNotThrow(() => buildMessage({}));
  assert.doesNotThrow(() => buildMessage({ AlarmName: 'x', AlarmDescription: '{"unclosed": ' }));
});

test('the header stays within Slack plain_text limits', () => {
  const message = buildMessage(alarmEvent({ AlarmName: 'a'.repeat(300) }));
  assert.ok(message.attachments[0].blocks[0].text.text.length <= 150);
});
