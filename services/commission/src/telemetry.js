// Loaded via `node --import` so instrumentation is registered before the
// application imports anything it needs to patch. Same setup as POS/Payments.
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { NodeSDK } from '@opentelemetry/sdk-node';

// X-Ray format ids and propagation, so the collector's awsxray exporter
// accepts the spans and POS/Payments join the same trace.
const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  idGenerator: new AWSXRayIdGenerator(),
  textMapPropagator: new AWSXRayPropagator(),
  instrumentations: [getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false },
  })],
});

sdk.start();

// Unlike the servers, Commission is a one-shot job: it exits as soon as the
// close finishes. run.js awaits this before exiting so buffered spans are
// exported to the ADOT sidecar instead of being lost with the process.
export function shutdownTelemetry() {
  return sdk.shutdown();
}
