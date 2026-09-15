// Loaded via `node --import` so instrumentation is registered before the
// application imports anything it needs to patch.
import { trace } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { NodeSDK } from '@opentelemetry/sdk-node';

// X-Ray rejects trace ids whose timestamp segment it cannot parse, so ids and
// propagation must use its format for the collector's awsxray exporter to
// accept the spans.
const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  idGenerator: new AWSXRayIdGenerator(),
  textMapPropagator: new AWSXRayPropagator(),
  instrumentations: [getNodeAutoInstrumentations({
    // Health and readiness polls would otherwise dominate every trace view.
    '@opentelemetry/instrumentation-http': {
      ignoreIncomingRequestHook: (request) => {
        const path = request.url?.split('?')[0];
        return path === '/health' || path === '/ready';
      },
    },
    '@opentelemetry/instrumentation-fs': { enabled: false },
  })],
});

sdk.start();

process.on('SIGTERM', () => { sdk.shutdown().catch(() => {}); });

// Lets log lines join the trace they belong to. Returns nothing outside a span,
// so log entries stay valid JSON either way.
export function traceContext() {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext) return {};
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}
