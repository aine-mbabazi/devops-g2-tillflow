// Must run before ./telemetry.js. Without this hook the service is ESM, so
// `import { createServer } from 'node:http'` binds the original function before
// the SDK can patch it, and every span is silently missing.
import { register } from 'node:module';

// Resolved against this file rather than the working directory: the image runs
// from /app while node_modules sits at /app/services/payments/node_modules, so
// a cwd-relative parent finds nothing and the hook silently fails to load —
// taking every span with it.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
