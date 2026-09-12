import http from 'node:http';
import { performance } from 'node:perf_hooks';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const requests = Math.min(Math.max(Number(args.requests ?? 3000), 1), 100000);
const concurrency = Math.min(Math.max(Number(args.concurrency ?? 100), 1), 1000);
const timeoutMs = Math.min(Math.max(Number(args.timeout ?? 250), 10), 5000);
const remoteTarget = args.target;

if (remoteTarget && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(remoteTarget)) {
  throw new Error('Remote/production load targets are blocked. Use a local or staging-safe mock only.');
}

const seen = new Map();
const server = remoteTarget ? null : http.createServer((req, res) => {
  const idempotencyKey = req.headers['x-idempotency-key'];
  const sequence = Number(String(idempotencyKey).split('-').at(-1)) || 0;
  // 600ms is deliberately far past any reasonable --timeout (default 250ms,
  // 400ms in CI) so this slow-path request reliably times out on every run,
  // on any machine -- 350ms sat too close to a 400ms cutoff and whether it
  // actually tripped the timeout became a coin flip between runs (5/5 timed
  // out locally, 0/1 on GitHub's runner, same code, same day). See the
  // "Tune the resilience load test" commit for the full story.
  const latency = sequence % 50 === 0 ? 600 : 5 + (sequence % 25);
  setTimeout(() => {
    if (sequence % 100 === 1) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"success":false,"retryable":true}');
      return;
    }
    const transactionId = seen.get(idempotencyKey) ?? `tx-${sequence}`;
    seen.set(idempotencyKey, transactionId);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, transactionId }));
  }, latency);
});

if (server) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server?.address();
const target = remoteTarget ?? `http://127.0.0.1:${address.port}/mock-purchase`;
const latencies = [];
let succeeded = 0;
let failed = 0;
let timedOut = 0;
let cursor = 0;

async function worker() {
  while (cursor < requests) {
    const sequence = cursor++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-idempotency-key': `load-${sequence}` },
        body: '{"amount":100}',
        signal: controller.signal,
      });
      latencies.push(performance.now() - started);
      if (response.ok) succeeded++; else failed++;
      await response.arrayBuffer();
    } catch (error) {
      if (error?.name === 'AbortError') timedOut++; else failed++;
    } finally {
      clearTimeout(timer);
    }
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, () => worker()));
const elapsedMs = performance.now() - started;
if (server) await new Promise((resolve) => server.close(resolve));
latencies.sort((a, b) => a - b);
const percentile = (p) => latencies[Math.min(Math.floor(latencies.length * p), latencies.length - 1)] ?? 0;
const report = {
  requests,
  concurrency,
  succeeded,
  expected503: failed,
  timedOut,
  requestsPerSecond: Number((requests / (elapsedMs / 1000)).toFixed(1)),
  p50Ms: Number(percentile(0.50).toFixed(1)),
  p95Ms: Number(percentile(0.95).toFixed(1)),
  p99Ms: Number(percentile(0.99).toFixed(1)),
};
console.log(JSON.stringify(report, null, 2));

if (!remoteTarget && (timedOut < 1 || failed < 1 || succeeded < requests * 0.9)) {
  throw new Error('Resilience assertions failed');
}
