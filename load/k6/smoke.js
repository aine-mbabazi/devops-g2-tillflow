// Smoke — one virtual user, minimum load. Answers "is the golden path wired
// correctly?" before any of the heavier profiles are worth running. If this
// fails, nothing below it is meaningful.
import { sleep } from 'k6';
import {
  SHARED_THRESHOLDS, configureTenant, readTenantConfig, recordAndPaySale, summaryHandler,
} from './lib/journey.js';

export const options = {
  vus: 1,
  duration: '30s',
  thresholds: SHARED_THRESHOLDS,
};

export function setup() {
  if (!configureTenant()) throw new Error('tenant setup failed — aborting smoke');
}

export default function () {
  readTenantConfig();
  recordAndPaySale();
  sleep(1);
}

export const handleSummary = summaryHandler('smoke');
