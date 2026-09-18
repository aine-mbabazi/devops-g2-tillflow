#!/usr/bin/env node
// Every CloudWatch alarm carries a `runbook` anchor in its alert contract, and
// the Slack notifier turns it into a link. A link to a heading that does not
// exist is worse than no link: it costs an on-call engineer a page load to find
// out there is no guidance, at the moment they least have time for it.
//
// This fails the build when an alarm points at a runbook section nobody wrote.
// It is the mechanical half of the rule in docs/runbook.md — "if you add an
// alarm, add its section here in the same PR".
//
// Run: node scripts/check-alarm-runbook-anchors.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const INFRA_DIR = 'infra/main';
const RUNBOOK = 'docs/runbook.md';

// GitHub's heading-slug rules: lowercase, drop anything that is not a word
// character, whitespace or hyphen, then collapse whitespace to hyphens.
function slug(heading) {
  return heading.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

const terraform = readdirSync(INFRA_DIR)
  .filter((name) => name.endsWith('.tf'))
  .map((name) => ({ file: name, body: readFileSync(join(INFRA_DIR, name), 'utf8') }));

const references = [];
for (const { file, body } of terraform) {
  for (const match of body.matchAll(/runbook\s*=\s*"#([a-z0-9-]+)"/g)) {
    references.push({ file, anchor: match[1] });
  }
}

const headings = new Set(
  [...readFileSync(RUNBOOK, 'utf8').matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => slug(m[1])),
);

const broken = references.filter(({ anchor }) => !headings.has(anchor));

if (broken.length) {
  console.error(`\n${broken.length} alarm(s) link to a runbook section that does not exist:\n`);
  for (const { file, anchor } of broken) {
    console.error(`  ${file}  ->  ${RUNBOOK}#${anchor}`);
  }
  console.error(`\nAdd the matching heading to ${RUNBOOK}, or correct the anchor.\n`);
  process.exit(1);
}

// An alarm with no runbook anchor at all is the other half of the same problem,
// and it is not something a missing-heading check would ever notice.
const alarmNames = [];
for (const { body } of terraform) {
  for (const match of body.matchAll(/resource\s+"aws_cloudwatch_metric_alarm"\s+"([a-z0-9_]+)"/g)) {
    alarmNames.push(match[1]);
  }
}

console.log(`${alarmNames.length} alarm resources, ${references.length} runbook references, all resolving.`);

if (references.length < alarmNames.length) {
  console.error(
    `\nOnly ${references.length} of ${alarmNames.length} alarm resources carry a runbook anchor.\n`
    + 'Every alarm needs one — see docs/alert-contract.md.\n',
  );
  process.exit(1);
}
