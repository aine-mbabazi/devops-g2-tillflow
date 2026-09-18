// Capacity — find the knee, not confirm the envelope.
//
// The stepped baseline answers "do the SLOs hold at expected load?" and it
// passed without ever saturating anything, which means it did not answer the
// question the brief actually asks: the highest sustained RPS where SLOs still
// hold. A profile that never breaks cannot report a ceiling.
//
// So this one is built to fail. It ramps well past the baseline's top step and
// keeps going until latency or errors break the envelope. The interesting
// output is the last step that held, not the exit code — which is why the
// thresholds below are NOT abortOnFail: the run is supposed to finish and
// report, not stop at the first breach.
import { sleep } from 'k6';
import {
  configureTenant, readTenantConfig, recordAndPaySale, summaryHandler,
} from './lib/journey.js';

const STEP = '90s';

export const options = {
  scenarios: {
    capacity: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 2000,
      stages: [
        { target: 100, duration: STEP },
        { target: 250, duration: STEP },
        { target: 500, duration: STEP },
        { target: 1000, duration: STEP },
        { target: 1500, duration: STEP },
      ],
    },
  },
  thresholds: {
    // Recorded, not enforced. A breach here is the measurement, so failing the
    // run on it would throw away the result the run exists to produce.
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.99'],
    // The one exception. However saturated the system gets, it must not take
    // money twice — so this threshold is a real pass/fail even here.
    tillflow_duplicate_dispatch: ['count==0'],
  },
};

export function setup() {
  if (!configureTenant()) throw new Error('tenant setup failed — aborting capacity run');
}

export default function () {
  readTenantConfig();
  readTenantConfig();
  readTenantConfig();
  recordAndPaySale();
  sleep(0.1);
}

export const handleSummary = summaryHandler('capacity');
