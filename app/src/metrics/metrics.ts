import { Request, Response, NextFunction } from 'express';

interface MetricsState {
  requestsTotal: number;
  errorsTotal: number;
  byRoute: Record<string, { count: number; totalMs: number }>;
  latencies: number[];
}

const state: MetricsState = {
  requestsTotal: 0,
  errorsTotal: 0,
  byRoute: {},
  latencies: []
};

export function resetMetrics(): void {
  state.requestsTotal = 0;
  state.errorsTotal = 0;
  state.byRoute = {};
  state.latencies = [];
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    state.requestsTotal += 1;
    if (res.statusCode >= 500) state.errorsTotal += 1;
    const route = `${req.method} ${req.route?.path || req.path}`;
    const r = state.byRoute[route] || { count: 0, totalMs: 0 };
    r.count += 1;
    r.totalMs += ms;
    state.byRoute[route] = r;
    state.latencies.push(ms);
    if (state.latencies.length > 1000) state.latencies.shift();
  });
  next();
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function getMetricsSnapshot() {
  return {
    requestsTotal: state.requestsTotal,
    errorsTotal: state.errorsTotal,
    errorRate:
      state.requestsTotal === 0 ? 0 : state.errorsTotal / state.requestsTotal,
    p50Ms: percentile(state.latencies, 50),
    p95Ms: percentile(state.latencies, 95),
    p99Ms: percentile(state.latencies, 99)
  };
}

/** Prometheus text exposition format. */
export function renderPrometheus(): string {
  const snap = getMetricsSnapshot();
  const lines = [
    '# HELP ems_requests_total Total HTTP requests',
    '# TYPE ems_requests_total counter',
    `ems_requests_total ${snap.requestsTotal}`,
    '# HELP ems_errors_total Total HTTP 5xx responses',
    '# TYPE ems_errors_total counter',
    `ems_errors_total ${snap.errorsTotal}`,
    '# HELP ems_request_latency_ms Request latency percentiles',
    '# TYPE ems_request_latency_ms gauge',
    `ems_request_latency_ms{quantile="0.5"} ${snap.p50Ms}`,
    `ems_request_latency_ms{quantile="0.95"} ${snap.p95Ms}`,
    `ems_request_latency_ms{quantile="0.99"} ${snap.p99Ms}`
  ];
  return lines.join('\n') + '\n';
}
