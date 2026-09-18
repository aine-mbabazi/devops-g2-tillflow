// Spike — a market-day surge: a tenfold jump inside 10 seconds, held briefly,
// then released. What this profile is really testing is recovery, not the
// peak: whether latency returns to baseline after the surge passes, and
// whether anything was accepted twice while the service was saturated.
import { sleep } from 'k6';
import {
  SHARED_THRESHOLDS, configureTenant, readTenantConfig, recordAndPaySale, summaryHandler,
} from './lib/journey.js';

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 600,
      stages: [
        { target: 10, duration: '1m' },   // settle at baseline
        { target: 150, duration: '10s' }, // surge
        { target: 150, duration: '1m' },  // hold
        { target: 10, duration: '10s' },  // release
        { target: 10, duration: '2m' },   // recovery window — the real assertion
      ],
    },
  },
  thresholds: {
    ...SHARED_THRESHOLDS,
    // Latency is deliberately NOT held to 500ms across the whole spike run:
    // degrading under a 15x surge is acceptable, staying degraded afterwards
    // is not. The envelope is relaxed for the run as a whole and the recovery
    // window is judged from the time series in the exported JSON.
    http_req_duration: ['p(95)<2000'],
    // Correctness, however, does not get a relaxed threshold. Saturation is
    // exactly when a double-charge would appear, so this stays at zero.
    tillflow_duplicate_dispatch: ['count==0'],
  },
};

export function setup() {
  if (!configureTenant()) throw new Error('tenant setup failed — aborting spike');
}

export default function () {
  readTenantConfig();
  recordAndPaySale();
  sleep(0.1);
}

export const handleSummary = summaryHandler('spike');
