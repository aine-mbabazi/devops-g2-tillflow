// Must run before ./telemetry.js. Without this hook the service is ESM, so
// `import { createServer } from 'node:http'` binds the original function before
// the SDK can patch it, and every span is silently missing.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('@opentelemetry/instrumentation/hook.mjs', pathToFileURL('./'));
