// Spike — a market-day surge: a tenfold jump inside 10 seconds, held briefly,
// then released. What this profile is really testing is recovery, not the
// peak: whether latency returns to baseline after the surge passes, and
// whether anything was accepted twice while the service was saturated.
import { sleep } from 'k6';
import {
  SHARED_THRESHOLDS, configureTenant, readTenantConfig, recordAndPaySale, summaryHandler,
} from './lib/journey.js';

// Defaults are the laptop-sized local numbers this file has always used.
// Override SPIKE_BASE_RATE/SPIKE_PEAK_RATE to point the same tenfold-surge
// shape at a deployed desired_count=1 target — start low, e.g.
// SPIKE_BASE_RATE=1 SPIKE_PEAK_RATE=10.
const BASE_RATE = Number(__ENV.SPIKE_BASE_RATE || 10);
const PEAK_RATE = Number(__ENV.SPIKE_PEAK_RATE || 150);

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: BASE_RATE,
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.SPIKE_PREALLOC_VUS || 100),
      maxVUs: Number(__ENV.SPIKE_MAX_VUS || 600),
      stages: [
        { target: BASE_RATE, duration: '1m' },   // settle at baseline
        { target: PEAK_RATE, duration: '10s' },  // surge
        { target: PEAK_RATE, duration: '1m' },   // hold
        { target: BASE_RATE, duration: '10s' },  // release
        { target: BASE_RATE, duration: '2m' },   // recovery window — the real assertion
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
