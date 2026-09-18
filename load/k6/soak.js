// Soak — 16 minutes at a rate the stepped baseline showed is comfortably
// sustainable. The brief asks for ≥15 minutes; the extra minute is warm-up
// that gets excluded from the analysis.
//
// A soak is not a second latency test. It is looking for the failures that
// only appear with time: memory growth in the in-memory stores, connection
// pool exhaustion, file descriptor leaks, and latency that drifts upward
// while throughput stays flat.
import { sleep } from 'k6';
import {
  SHARED_THRESHOLDS, configureTenant, readTenantConfig, recordAndPaySale, summaryHandler,
} from './lib/journey.js';

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.SOAK_RATE || 20),
      timeUnit: '1s',
      duration: __ENV.SOAK_DURATION || '16m',
      preAllocatedVUs: 60,
      maxVUs: 300,
    },
  },
  thresholds: {
    ...SHARED_THRESHOLDS,
    dropped_iterations: ['count<10'],
  },
};

export function setup() {
  if (!configureTenant()) throw new Error('tenant setup failed — aborting soak');
}

export default function () {
  readTenantConfig();
  readTenantConfig();
  readTenantConfig();
  recordAndPaySale();
  sleep(0.1);
}

export const handleSummary = summaryHandler('soak');
