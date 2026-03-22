/**
 * Metrics collection module for tracking server performance.
 * Tracks connections, messages, latency, memory, CPU, event loop lag, and dropped connections.
 */

const { monitorEventLoopDelay } = require('perf_hooks');

// ── Basic counters ──────────────────────────────────────────────────────────────

let connections = 0;
let messagesSent = 0;
let totalLatency = 0;
let latencySamples = 0;
let droppedConnections = 0;
let bytesSent = 0;
let maxBufferedAmount = 0;

// ── Baseline RSS ────────────────────────────────────────────────────────────────

const baselineRSS = process.memoryUsage().rss;

// ── Circular buffer helper ──────────────────────────────────────────────────────

function createCircularBuffer(capacity) {
  const buffer = new Float64Array(capacity);
  let head = 0;
  let count = 0;
  return {
    push(value) {
      buffer[head] = value;
      head = (head + 1) % capacity;
      if (count < capacity) count++;
    },
    /** Return a plain array of active samples (unsorted). */
    snapshot() {
      if (count < capacity) {
        return Array.from(buffer.subarray(0, count));
      }
      return Array.from(buffer.subarray(head)).concat(Array.from(buffer.subarray(0, head)));
    },
    getCount() { return count; },
    clear() { head = 0; count = 0; },
  };
}

function computePercentiles(circBuf) {
  const count = circBuf.getCount();
  if (count === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0, count: 0, stddev: 0 };
  }
  const sorted = circBuf.snapshot().sort((a, b) => a - b);
  const n = sorted.length;
  const pIndex = (p) => sorted[Math.min(Math.floor(p * n), n - 1)];
  const sum = sorted.reduce((a, v) => a + v, 0);
  const avg = sum / n;
  const variance = sorted.reduce((a, v) => a + (v - avg) * (v - avg), 0) / n;
  return {
    p50: Math.round(pIndex(0.50) * 100) / 100,
    p95: Math.round(pIndex(0.95) * 100) / 100,
    p99: Math.round(pIndex(0.99) * 100) / 100,
    min: sorted[0],
    max: sorted[n - 1],
    avg: Math.round(avg * 100) / 100,
    count: n,
    stddev: Math.round(Math.sqrt(variance) * 100) / 100,
  };
}

// ── Latency percentile tracking (10 000 sample circular buffer) ─────────────

const latencyBuffer = createCircularBuffer(10000);

// ── Connection time percentile tracking ─────────────────────────────────────

const connectionTimeBuffer = createCircularBuffer(10000);

// ── Sliding-window messages per second (5 one-second buckets) ───────────────

const MSG_BUCKET_COUNT = 5;
const msgBuckets = new Uint32Array(MSG_BUCKET_COUNT);
let msgBucketIndex = 0;
let msgCurrentCount = 0;
let msgLastTickSec = Math.floor(Date.now() / 1000);

function rotateMsgBuckets() {
  const nowSec = Math.floor(Date.now() / 1000);
  const elapsed = nowSec - msgLastTickSec;
  if (elapsed <= 0) return;
  const steps = Math.min(elapsed, MSG_BUCKET_COUNT);
  for (let i = 0; i < steps; i++) {
    msgBucketIndex = (msgBucketIndex + 1) % MSG_BUCKET_COUNT;
    msgBuckets[msgBucketIndex] = 0;
  }
  // Commit current accumulator into the previous bucket before advancing
  // The bucket we just rotated away from holds the completed second's count
  const prevIndex = (msgBucketIndex - steps + MSG_BUCKET_COUNT) % MSG_BUCKET_COUNT;
  if (steps <= MSG_BUCKET_COUNT) {
    msgBuckets[prevIndex] += msgCurrentCount;
  }
  msgCurrentCount = 0;
  msgLastTickSec = nowSec;
}

// ── Bandwidth tracking (5 one-second buckets) ───────────────────────────────

const BW_BUCKET_COUNT = 5;
const bwBuckets = new Float64Array(BW_BUCKET_COUNT);
let bwBucketIndex = 0;
let bwCurrentBytes = 0;
let bwLastTickSec = Math.floor(Date.now() / 1000);

function rotateBwBuckets() {
  const nowSec = Math.floor(Date.now() / 1000);
  const elapsed = nowSec - bwLastTickSec;
  if (elapsed <= 0) return;
  const steps = Math.min(elapsed, BW_BUCKET_COUNT);
  const prevIndex = (bwBucketIndex) % BW_BUCKET_COUNT;
  // Commit in-flight bytes to the current bucket before rotating
  bwBuckets[prevIndex] += bwCurrentBytes;
  bwCurrentBytes = 0;
  for (let i = 0; i < steps; i++) {
    bwBucketIndex = (bwBucketIndex + 1) % BW_BUCKET_COUNT;
    bwBuckets[bwBucketIndex] = 0;
  }
  bwLastTickSec = nowSec;
}

// ── CPU usage: sample over a time window for stable readings ────────────────

const CPU_WINDOW_MS = 5000;
const CPU_MIN_ELAPSED_MS = 500;
let cpuSamples = [];
let lastCpuUsage = process.cpuUsage();
let lastCpuCheck = Date.now();
let lastCpuSampleTs = 0;

function sampleCpu() {
  const now = Date.now();
  const current = process.cpuUsage(lastCpuUsage);
  const elapsedSec = (now - lastCpuCheck) / 1000;
  lastCpuUsage = process.cpuUsage();
  lastCpuCheck = now;
  if (elapsedSec >= CPU_MIN_ELAPSED_MS / 1000 && now - lastCpuSampleTs >= CPU_MIN_ELAPSED_MS) {
    lastCpuSampleTs = now;
    const totalUs = current.user + current.system;
    const percent = Math.min(100, Math.round((totalUs / 1e6 / elapsedSec) * 100));
    cpuSamples.push({ percent, ts: now });
    while (cpuSamples.length > 0 && now - cpuSamples[0].ts > CPU_WINDOW_MS) {
      cpuSamples.shift();
    }
  }
}
const cpuSampleInterval = setInterval(sampleCpu, 1000);

// ── Event loop lag ──────────────────────────────────────────────────────────

let eventLoopLagMs = 0;
let lastLagCheck = Date.now();
const lagCheckInterval = setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastLagCheck;
  eventLoopLagMs = Math.round(Math.max(0, elapsed - 100));
  lastLagCheck = now;
}, 100);

// monitorEventLoopDelay (Node 12+) for high-resolution p99 lag
let eld = null;
if (typeof monitorEventLoopDelay === 'function') {
  try {
    eld = monitorEventLoopDelay({ resolution: 20 });
    eld.enable();
  } catch (_) {
    // Fallback: eld stays null
  }
}

function getEventLoopLagP99() {
  if (eld) {
    return Math.round(eld.percentile(99) / 1e6 * 100) / 100; // ns -> ms
  }
  // Fallback: use the setInterval-based lag value as a rough proxy
  return eventLoopLagMs;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Increment active connection count
 */
function addConnection() {
  connections++;
}

/**
 * Decrement active connection count
 */
function removeConnection() {
  if (connections > 0) connections--;
}

/**
 * Record dropped connection (e.g., write failure, slow client)
 */
function recordDroppedConnection() {
  droppedConnections++;
}

/**
 * Record that a message was sent
 */
function recordMessageSent() {
  messagesSent++;
  rotateMsgBuckets();
  msgCurrentCount++;
}

/**
 * Record latency sample from client (client calculates: Date.now() - timestamp)
 * @param {number} latency - Latency in milliseconds
 */
function recordLatency(latency) {
  if (typeof latency === 'number' && latency >= 0) {
    totalLatency += latency;
    latencySamples++;
    latencyBuffer.push(latency);
  }
}

/**
 * Record a connection establishment time in milliseconds.
 * @param {number} durationMs - Connection time in milliseconds
 */
function recordConnectionTime(durationMs) {
  if (typeof durationMs === 'number' && durationMs >= 0) {
    connectionTimeBuffer.push(durationMs);
  }
}

/**
 * Record bytes sent for bandwidth tracking.
 * @param {number} bytes - Number of bytes sent
 */
function recordBytesSent(bytes) {
  if (typeof bytes === 'number' && bytes > 0) {
    bytesSent += bytes;
    rotateBwBuckets();
    bwCurrentBytes += bytes;
  }
}

/**
 * Track max buffered amount across WebSocket clients
 * @param {number} amount - Current bufferedAmount value
 */
function recordBufferedAmount(amount) {
  if (typeof amount === 'number' && amount > maxBufferedAmount) {
    maxBufferedAmount = amount;
  }
}

/**
 * Get latency percentiles from the circular buffer.
 * @returns {{ p50, p95, p99, min, max, avg, count, stddev }}
 */
function getLatencyPercentiles() {
  return computePercentiles(latencyBuffer);
}

/**
 * Get connection time percentiles from the circular buffer.
 * @returns {{ p50, p95, p99, min, max, avg, count, stddev }}
 */
function getConnectionTimePercentiles() {
  return computePercentiles(connectionTimeBuffer);
}

/**
 * Get current memory usage
 * @returns {{ heapMB: number, rssMB: number, externalMB: number, arrayBuffersMB: number }}
 */
function getMemoryUsage() {
  const used = process.memoryUsage();
  return {
    heapMB: Math.round(used.heapUsed / 1024 / 1024),
    rssMB: Math.round(used.rss / 1024 / 1024),
    externalMB: Math.round((used.external || 0) / 1024 / 1024),
    arrayBuffersMB: Math.round((used.arrayBuffers || 0) / 1024 / 1024),
  };
}

/**
 * Get the baseline RSS recorded at module load time (bytes).
 * @returns {number}
 */
function getBaselineRSS() {
  return baselineRSS;
}

/**
 * Get estimated memory per connection in kilobytes.
 * @returns {number}
 */
function getMemoryPerConnection() {
  if (connections <= 0) return 0;
  const currentRSS = process.memoryUsage().rss;
  return Math.round((currentRSS - baselineRSS) / connections / 1024 * 100) / 100;
}

/**
 * Get CPU usage percentage over a time window (stable, not instant spike)
 * @returns {number} CPU usage 0-100
 */
function getCpuUsagePercent() {
  sampleCpu();
  if (cpuSamples.length === 0) return 0;
  const sum = cpuSamples.reduce((a, s) => a + s.percent, 0);
  return Math.round(sum / cpuSamples.length);
}

/**
 * Get messages per second (idempotent, sliding window of 5 one-second buckets).
 * @returns {number}
 */
function getMessagesPerSecond() {
  rotateMsgBuckets();
  let total = 0;
  for (let i = 0; i < MSG_BUCKET_COUNT; i++) {
    total += msgBuckets[i];
  }
  total += msgCurrentCount;
  return Math.round(total / MSG_BUCKET_COUNT);
}

/**
 * Get bandwidth in bytes per second (sliding window).
 * @returns {number}
 */
function getBandwidthBytesPerSec() {
  rotateBwBuckets();
  let total = 0;
  for (let i = 0; i < BW_BUCKET_COUNT; i++) {
    total += bwBuckets[i];
  }
  total += bwCurrentBytes;
  return Math.round(total / BW_BUCKET_COUNT);
}

/**
 * Get all metrics as an object
 */
function getMetrics() {
  const mem = getMemoryUsage();
  const lp = getLatencyPercentiles();
  const ctp = getConnectionTimePercentiles();
  return {
    connections,
    messagesSent,
    messagesPerSecond: getMessagesPerSecond(),
    avgLatency: latencySamples > 0 ? Math.round(totalLatency / latencySamples) : 0,
    latencyPercentiles: {
      p50: lp.p50,
      p95: lp.p95,
      p99: lp.p99,
      min: lp.min,
      max: lp.max,
      stddev: lp.stddev,
    },
    memoryUsage: mem,
    baselineRSSMB: Math.round(baselineRSS / 1024 / 1024),
    memoryPerConnectionKB: getMemoryPerConnection(),
    cpuUsagePercent: getCpuUsagePercent(),
    eventLoopLagMs,
    eventLoopLagP99Ms: getEventLoopLagP99(),
    droppedConnections,
    bandwidthBytesPerSec: getBandwidthBytesPerSec(),
    connectionTimePercentiles: {
      p50: ctp.p50,
      p95: ctp.p95,
      p99: ctp.p99,
    },
    // Preserved existing fields
    bytesSent,
    maxBufferedAmount,
    avgConnectionTimeMs: connectionTimeBuffer.getCount() > 0
      ? Math.round(computePercentiles(connectionTimeBuffer).avg)
      : 0,
  };
}

/**
 * Reset all metrics (useful for fresh benchmark runs)
 */
function resetMetrics() {
  connections = 0;
  messagesSent = 0;
  totalLatency = 0;
  latencySamples = 0;
  droppedConnections = 0;
  bytesSent = 0;
  maxBufferedAmount = 0;

  // Sliding window msg/sec
  msgBuckets.fill(0);
  msgBucketIndex = 0;
  msgCurrentCount = 0;
  msgLastTickSec = Math.floor(Date.now() / 1000);

  // Bandwidth sliding window
  bwBuckets.fill(0);
  bwBucketIndex = 0;
  bwCurrentBytes = 0;
  bwLastTickSec = Math.floor(Date.now() / 1000);

  // Circular buffers
  latencyBuffer.clear();
  connectionTimeBuffer.clear();

  // Event loop delay histogram
  if (eld) {
    eld.reset();
  }
}

module.exports = {
  // Existing exports (backward-compatible)
  addConnection,
  removeConnection,
  recordDroppedConnection,
  recordMessageSent,
  recordLatency,
  recordBytesSent,
  recordBufferedAmount,
  recordConnectionTime,
  getMetrics,
  getMemoryUsage,
  getCpuUsagePercent,
  resetMetrics,
  // New exports
  getLatencyPercentiles,
  getConnectionTimePercentiles,
  getBaselineRSS,
  getMemoryPerConnection,
  getMessagesPerSecond,
  getBandwidthBytesPerSec,
};
