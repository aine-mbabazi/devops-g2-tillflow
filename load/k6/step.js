// A single sustained rate, held long enough to judge. This is the profile that
// actually answers "the highest sustained RPS where SLOs hold".
//
// capacity.js ramps until the envelope breaks, which proves a ceiling exists
// and roughly where — but its summary is an aggregate across every step, so a
// run that ends at 11% errors cannot say whether 250 RPS was fine and 1000 was
// not. Running one rate at a time gives each candidate its own pass/fail
// verdict and its own exported JSON, and each run is cheap.
//
//   k6 run -e STEP_RATE=250 load/k6/step.js
//
// Thresholds here are the brief's envelope, enforced: a run either holds the
// SLOs at that rate or it does not.
import { sleep } from 'k6';
import {
  SHARED_THRESHOLDS, configureTenant, readTenantConfig, recordAndPaySale, summaryHandler,
} from './lib/journey.js';

const RATE = Number(__ENV.STEP_RATE || 250);

export const options = {
  scenarios: {
    step: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.STEP_DURATION || '90s',
      // Generous relative to the rate: a starved VU pool shows up as dropped
      // iterations, which would be read as the service failing when it is
      // really the load generator failing to apply the load.
      preAllocatedVUs: Math.max(100, RATE),
      maxVUs: Math.max(500, RATE * 4),
    },
  },
  thresholds: {
    ...SHARED_THRESHOLDS,
    // If the generator cannot sustain the arrival rate, the run did not test
    // what it claims to have tested, so this is a hard failure rather than a
    // footnote.
    dropped_iterations: ['count<100'],
  },
};

export function setup() {
  if (!configureTenant()) throw new Error(`tenant setup failed — aborting step at ${RATE} RPS`);
}

export default function () {
  readTenantConfig();
  readTenantConfig();
  readTenantConfig();
  recordAndPaySale();
  sleep(0.1);
}

export const handleSummary = summaryHandler(`step-${RATE}`);
