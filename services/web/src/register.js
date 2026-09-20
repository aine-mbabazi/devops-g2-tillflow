// Must run before ./telemetry.js. Without this hook the service is ESM, so
// `import { createServer } from 'node:http'` binds the original function before
// the SDK can patch it, and every span is silently missing.
import { register } from 'node:module';

// Resolved against this file rather than the working directory: the image
// keeps node_modules alongside src at /app, and a cwd-relative parent finds
// nothing if the process is ever started from elsewhere.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
