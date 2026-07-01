/**
 * NCO Telemetry — OpenTelemetry tracing layer (TraceRoot-compatible).
 * Instruments agent task execution with spans so any OTLP-compatible backend
 * (Jaeger, Zipkin, TraceRoot, Grafana Tempo) can visualise agent traces.
 *
 * Activation: set OTEL_EXPORTER_OTLP_ENDPOINT in .env (e.g. http://localhost:4318).
 * If the env var is absent, telemetry initialises in noop mode — zero overhead.
 */
import { createLogger } from '../utils/logger.js';

const log = createLogger('telemetry');

// Lazy-loaded OTel objects
let tracer: any = null;
let initialized = false;

export async function initTelemetry(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    log.info('OTEL_EXPORTER_OTLP_ENDPOINT not set — telemetry in noop mode');
    return;
  }

  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const { SEMRESATTRS_SERVICE_NAME } = await import('@opentelemetry/semantic-conventions');
    const { trace } = await import('@opentelemetry/api');

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [SEMRESATTRS_SERVICE_NAME]: 'nco-backend',
      }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    });

    sdk.start();

    tracer = trace.getTracer('nco-agent-manager', '1.0.0');

    // Graceful shutdown
    process.on('SIGTERM', () => sdk.shutdown());
    process.on('SIGINT', () => sdk.shutdown());

    log.info({ endpoint }, 'OpenTelemetry tracing initialized');
  } catch (err: any) {
    log.warn({ err: err.message }, 'OTel init failed — noop mode');
  }
}

/**
 * Wrap an async operation in an OTel span.
 * If telemetry is in noop mode, runs fn directly without overhead.
 */
export async function withSpan<T>(
  spanName: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>
): Promise<T> {
  if (!tracer) return fn();

  const { context, SpanStatusCode } = await import('@opentelemetry/api');
  const span = tracer.startSpan(spanName, { attributes });
  return context.with(tracer.contextWithSpan ? tracer.contextWithSpan(span) : context.active(), async () => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}
