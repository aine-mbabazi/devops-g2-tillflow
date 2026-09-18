// Stepped baseline — the run the capacity model is built from.
//
// Arrival-rate (open model) rather than a fixed VU count on purpose: with a
// closed VU model, a slow service simply produces fewer requests and the test
// quietly measures the service's own pace instead of a target load. Holding
// arrival rate constant per step is what makes "the highest sustained RPS
// where SLOs still hold" a question the run can actually answer.
import { sleep } from 'k6';
import {
  SHARED_THRESHOLDS, configureTenant, readTenantConfig, recordAndPaySale, summaryHandler,
} from './lib/journey.js';

const STEP = '2m';

export const options = {
  scenarios: {
    stepped: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      // Headroom for the pool to absorb a step change without the executor
      // reporting dropped iterations that are really allocation, not latency.
      preAllocatedVUs: 50,
      maxVUs: 400,
      stages: [
        { target: 5, duration: STEP },
        { target: 10, duration: STEP },
        { target: 20, duration: STEP },
        { target: 40, duration: STEP },
        { target: 60, duration: STEP },
      ],
    },
  },
  // dropped_iterations is the executor failing to start work at the target
  // rate. Without this threshold a run can "pass" while never having applied
  // the load it claims to have applied.
  thresholds: {
    ...SHARED_THRESHOLDS,
    dropped_iterations: ['count<10'],
  },
};

export function setup() {
  if (!configureTenant()) throw new Error('tenant setup failed — aborting baseline');
}

export default function () {
  // Read-to-write ratio of 3:1, matching the product shape: an attendant's
  // screen re-reads till config far more often than a sale is recorded.
  readTenantConfig();
  readTenantConfig();
  readTenantConfig();
  recordAndPaySale();
  sleep(0.1);
}

export const handleSummary = summaryHandler('baseline');
