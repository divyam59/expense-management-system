import { resetMetrics, getMetricsSnapshot, renderPrometheus } from '../../src/metrics/metrics';

describe('metrics', () => {
  beforeEach(() => resetMetrics());

  it('starts at zero', () => {
    const snap = getMetricsSnapshot();
    expect(snap.requestsTotal).toBe(0);
    expect(snap.errorRate).toBe(0);
  });

  it('renders prometheus format', () => {
    const text = renderPrometheus();
    expect(text).toContain('ems_requests_total');
    expect(text).toContain('ems_request_latency_ms');
  });
});
