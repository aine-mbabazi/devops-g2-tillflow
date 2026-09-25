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

const STEP = __ENV.BASELINE_STEP_DURATION || '2m';

// Defaults are the laptop-sized local numbers this file has always used.
// Override BASELINE_RATES (5 comma-separated targets) to point the same
// shape of ramp at a deployed desired_count=1 target, where the local
// ceiling does not apply and the deployed one is unmeasured — start low,
// e.g. BASELINE_RATES=1,2,4,6,8.
const RATES = (__ENV.BASELINE_RATES || '5,10,20,40,60').split(',').map(Number);
if (RATES.length !== 5 || RATES.some((r) => !Number.isFinite(r) || r <= 0)) {
  throw new Error('BASELINE_RATES must be 5 comma-separated positive numbers');
}

export const options = {
  scenarios: {
    stepped: {
      executor: 'ramping-arrival-rate',
      startRate: RATES[0],
      timeUnit: '1s',
      // Headroom for the pool to absorb a step change without the executor
      // reporting dropped iterations that are really allocation, not latency.
      // Defaults match the original hardcoded values exactly; override only
      // if a much lower/higher peak rate needs correspondingly less/more.
      preAllocatedVUs: Number(__ENV.BASELINE_PREALLOC_VUS || 50),
      maxVUs: Number(__ENV.BASELINE_MAX_VUS || 400),
      stages: RATES.map((target) => ({ target, duration: STEP })),
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
