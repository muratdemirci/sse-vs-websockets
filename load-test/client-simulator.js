#!/usr/bin/env node
/**
 * Client simulator for load testing SSE and WebSocket servers.
 *
 * Modes:
 *   latency       - Passive receive: measure delivery latency (default)
 *   broadcast     - Passive receive: measure broadcast fan-out
 *   scalability   - Progressive connection tiers
 *   echo          - Round-trip echo test
 *   throughput    - Rate ramp-up test
 *   payload-sweep - Message size impact test
 *   connection-cost - Handshake overhead measurement
 *   churn         - Connection stability under churn
 *   reconnect     - Recovery after mass disconnect
 *   binary        - Binary data throughput test
 *
 * Usage:
 *   node client-simulator.js websocket 1000
 *   node client-simulator.js sse 500 --mode=echo --echo-rate=20
 *   node client-simulator.js websocket 100 --mode=throughput --duration=60
 *   node client-simulator.js sse 100 --mode=payload-sweep
 *   node client-simulator.js websocket 1 --mode=connection-cost --iterations=500
 *   node client-simulator.js sse 500 --mode=churn --duration=60
 *   node client-simulator.js websocket 200 --mode=reconnect
 *   node client-simulator.js sse 100 --mode=binary
 *
 * Flags:
 *   --duration=N        Test duration in seconds (default: 30)
 *   --mode=MODE         Test mode (see above)
 *   --message-size=N    Message size in bytes (default: 64)
 *   --echo-rate=N       Echoes per second per client for echo mode (default: 10)
 *   --rate=N            Initial server message rate (POSTs /config at start)
 *   --iterations=N      Iterations for connection-cost mode (default: 500)
 *   --max-connections=N Max SSE connections (default: 2000)
 *   --output=FILE       Write structured JSON results to file
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Server addresses
// ---------------------------------------------------------------------------
const WS_URL = 'ws://localhost:3001';
const WS_HOST = 'localhost';
const WS_PORT = 3001;
const SSE_HOST = 'localhost';
const SSE_PORT = 3002;
const SSE_PATH = '/events';

// ---------------------------------------------------------------------------
// Argument parsing helpers
// ---------------------------------------------------------------------------
function parseFlag(name, defaultValue, { min, max } = {}) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return defaultValue;
  const val = parseInt(arg.split('=')[1], 10);
  if (isNaN(val)) return defaultValue;
  let v = val;
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  return v;
}

function parseStringFlag(name, defaultValue) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return defaultValue;
  return arg.split('=').slice(1).join('=') || defaultValue;
}

const ALL_MODES = [
  'latency', 'broadcast', 'scalability',
  'echo', 'throughput', 'payload-sweep',
  'connection-cost', 'churn', 'reconnect', 'binary',
];

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const protocol = (args[0] || 'websocket').toLowerCase();
const clientCount = parseInt(args[1] || '100', 10);

const DURATION_SEC = parseFlag('duration', 30, { min: 1 });
const MESSAGE_SIZE = parseFlag('message-size', 64, { min: 16, max: 65536 });
const ECHO_RATE = parseFlag('echo-rate', 10, { min: 1, max: 1000 });
const INITIAL_RATE = parseFlag('rate', 0, { min: 0, max: 10000 });
const ITERATIONS = parseFlag('iterations', 500, { min: 1 });
const SSE_MAX_CONNECTIONS = parseFlag('max-connections', 2000, { min: 1 });
const OUTPUT_FILE = parseStringFlag('output', '');

const MODE = (() => {
  const raw = parseStringFlag('mode', 'latency').toLowerCase();
  return ALL_MODES.includes(raw) ? raw : 'latency';
})();

const SSE_CONNECT_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Global stats
// ---------------------------------------------------------------------------
const globalStats = {
  connections: 0,
  messagesReceived: 0,
  latencies: [],
  connectionTimes: [],
  errors: 0,
  droppedConnections: 0,
};

// Timeline snapshots (every 5 seconds)
const timeline = [];
let timelineInterval = null;

function startTimeline() {
  const t0 = Date.now();
  timelineInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const percs = globalStats.latencies.length > 0
      ? computePercentiles(globalStats.latencies)
      : { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0, stddev: 0 };
    timeline.push({
      elapsedSec: elapsed,
      connections: globalStats.connections,
      messagesReceived: globalStats.messagesReceived,
      latencyAvg: percs.avg,
      latencyP99: percs.p99,
      errors: globalStats.errors,
    });
  }, 5000);
}

function stopTimeline() {
  if (timelineInterval) {
    clearInterval(timelineInterval);
    timelineInterval = null;
  }
}

// ---------------------------------------------------------------------------
// Percentile computation
// ---------------------------------------------------------------------------
function computePercentiles(arr) {
  if (!arr || arr.length === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0, stddev: 0 };
  }
  const sorted = Float64Array.from(arr).sort();
  const len = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / len;

  let sqDiffSum = 0;
  for (let i = 0; i < len; i++) {
    const d = sorted[i] - avg;
    sqDiffSum += d * d;
  }
  const stddev = Math.sqrt(sqDiffSum / len);

  const pct = (p) => sorted[Math.min(Math.floor(len * p), len - 1)];
  return {
    p50: Math.round(pct(0.50) * 100) / 100,
    p95: Math.round(pct(0.95) * 100) / 100,
    p99: Math.round(pct(0.99) * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[len - 1] * 100) / 100,
    avg: Math.round(avg * 100) / 100,
    stddev: Math.round(stddev * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function httpGet(host, port, path, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: host, port, path, family: 4 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

function httpPost(host, port, path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: host, port, path, method: 'POST', family: 4,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

function serverHost() { return protocol === 'websocket' ? WS_HOST : SSE_HOST; }
function serverPort() { return protocol === 'websocket' ? WS_PORT : SSE_PORT; }

/** POST /config to set server parameters */
async function postConfig(config) {
  return httpPost(serverHost(), serverPort(), '/config', config);
}

/** POST /reset to clear server metrics */
async function postReset() {
  return httpPost(serverHost(), serverPort(), '/reset', {});
}

/** POST /disconnect-all to force disconnect all clients */
async function postDisconnectAll() {
  return httpPost(serverHost(), serverPort(), '/disconnect-all', {});
}

/** Fetch /metrics from the server */
async function fetchMetrics() {
  await delay(500);
  let result = await httpGet(serverHost(), serverPort(), '/metrics');
  if (!result && globalStats.connections > 1000) {
    await delay(1000);
    result = await httpGet(serverHost(), serverPort(), '/metrics');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Server health checks
// ---------------------------------------------------------------------------
function checkWSServer() {
  return new Promise((resolve) => {
    const req = http.get({ hostname: WS_HOST, port: WS_PORT, path: '/metrics', family: 4 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

function checkSSEServer() {
  return new Promise((resolve) => {
    const req = http.get({ hostname: SSE_HOST, port: SSE_PORT, path: '/metrics', family: 4 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

async function ensureServerUp() {
  const check = protocol === 'websocket' ? checkWSServer : checkSSEServer;
  const up = await check();
  if (!up) {
    const host = serverHost();
    const port = serverPort();
    console.error(`\nError: ${protocol} server not reachable at ${host}:${port}`);
    console.error(protocol === 'websocket'
      ? 'Start it with: node server/websocket-server.js'
      : 'Start it with: node server/sse-server.js');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function uuid() { return crypto.randomUUID(); }

// ---------------------------------------------------------------------------
// WebSocket client factory
// ---------------------------------------------------------------------------
function createWebSocketClient(id, { onMessage } = {}) {
  return new Promise((resolve, reject) => {
    const startConnect = Date.now();
    const ws = new WebSocket(WS_URL);

    ws.on('open', () => {
      globalStats.connections++;
      globalStats.connectionTimes.push(Date.now() - startConnect);
      resolve(ws);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (onMessage) {
          onMessage(msg, ws);
        } else if (msg.timestamp) {
          const latency = Date.now() - msg.timestamp;
          globalStats.latencies.push(latency);
          globalStats.messagesReceived++;
          if (MODE !== 'broadcast') {
            ws.send(JSON.stringify({ type: 'latency', latency }));
          }
        }
      } catch { /* ignore */ }
    });

    ws.on('error', () => { globalStats.errors++; reject(); });
    ws.on('close', () => { globalStats.droppedConnections++; });
  });
}

// ---------------------------------------------------------------------------
// SSE client factory
// ---------------------------------------------------------------------------
function createSSEClient(id, { queryParams, onMessage } = {}) {
  return new Promise((resolve) => {
    const startConnect = Date.now();
    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (tid) clearTimeout(tid);
      if (result === null) globalStats.errors++;
      resolve(result);
    };

    let path = SSE_PATH;
    if (queryParams) {
      const qs = Object.entries(queryParams).map(([k, v]) => `${k}=${v}`).join('&');
      path += '?' + qs;
    }

    const req = http.get(
      {
        hostname: SSE_HOST, port: SSE_PORT, path,
        headers: { Accept: 'text/event-stream' },
        family: 4,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(null);
          return;
        }
        globalStats.connections++;
        globalStats.connectionTimes.push(Date.now() - startConnect);

        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';
          for (const block of lines) {
            // SSE block may contain id: and data: lines
            const dataLine = block.split('\n').find(l => l.startsWith('data: '));
            if (dataLine) {
              try {
                const msg = JSON.parse(dataLine.slice(6));
                if (onMessage) {
                  onMessage(msg, { req, res });
                } else if (msg.timestamp) {
                  const latency = Date.now() - msg.timestamp;
                  globalStats.latencies.push(latency);
                  globalStats.messagesReceived++;
                  if (MODE !== 'broadcast') {
                    const postReq = http.request(
                      {
                        hostname: SSE_HOST, port: SSE_PORT, path: '/latency',
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                      },
                      () => {}
                    );
                    postReq.on('error', () => {});
                    postReq.write(JSON.stringify({ latency }));
                    postReq.end();
                  }
                }
              } catch { /* ignore */ }
            }
          }
        });
        res.on('error', () => {});
        finish({ req, res });
      }
    );

    const tid = setTimeout(() => {
      if (!resolved) { req.destroy(); finish(null); }
    }, SSE_CONNECT_TIMEOUT_MS);

    req.on('error', () => finish(null));
    req.on('socket', (socket) => { socket.on('error', () => finish(null)); });
  });
}

// ---------------------------------------------------------------------------
// Batch SSE connection helper
// ---------------------------------------------------------------------------
async function connectSSEBatch(count, opts = {}) {
  const effectiveCount = Math.min(count, SSE_MAX_CONNECTIONS);
  if (count > SSE_MAX_CONNECTIONS) {
    console.log(`Note: SSE capped at ${SSE_MAX_CONNECTIONS} to avoid port exhaustion\n`);
  }
  console.log(`Connecting ${effectiveCount} SSE clients...`);

  const batchSize = effectiveCount > 2000 ? 25 : 50;
  const batchDelay = effectiveCount > 2000 ? 200 : 50;
  const clients = [];
  let stuckBatches = 0;

  for (let i = 0; i < effectiveCount; i += batchSize) {
    const before = globalStats.connections;
    const batch = [];
    for (let j = 0; j < batchSize && i + j < effectiveCount; j++) {
      batch.push(createSSEClient(i + j, opts));
    }
    const results = await Promise.all(batch);
    clients.push(...results.filter(Boolean));
    const added = globalStats.connections - before;
    if (added === 0 && before >= 1000) {
      stuckBatches++;
      if (stuckBatches >= 2) {
        console.log(`\n  Server limit reached at ${before} connections. Proceeding with test.`);
        break;
      }
    } else {
      stuckBatches = 0;
    }
    process.stdout.write(`  ${globalStats.connections}/${effectiveCount}\r`);
    await delay(batchDelay);
  }
  return clients;
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------
function closeWSClients(clients) {
  clients.forEach((ws) => { try { ws.close(); } catch { /* ignore */ } });
}

function closeSSEClients(clients) {
  clients.forEach((c) => { try { if (c?.res) c.res.destroy(); } catch { /* ignore */ } });
}

function closeClients(clients) {
  if (protocol === 'websocket') closeWSClients(clients);
  else closeSSEClients(clients);
}

// ---------------------------------------------------------------------------
// MODE: latency / broadcast (original modes)
// ---------------------------------------------------------------------------
async function runWebSocketTest(count = clientCount) {
  const clients = [];
  console.log(`Connecting ${count} WebSocket clients...`);
  for (let i = 0; i < count; i++) {
    try {
      const ws = await createWebSocketClient(i);
      clients.push(ws);
      if ((i + 1) % 100 === 0) process.stdout.write(`  ${i + 1}/${count}\r`);
    } catch { /* counted */ }
  }
  console.log(`\nConnected: ${clients.length} clients. Running for ${DURATION_SEC}s...`);
  startTimeline();
  await delay(DURATION_SEC * 1000);
  stopTimeline();
  closeWSClients(clients);
  return clients;
}

async function runSSETest(count = clientCount) {
  const clients = await connectSSEBatch(count);
  console.log(`\nConnected: ${globalStats.connections} clients. Running for ${DURATION_SEC}s...`);
  startTimeline();
  await delay(DURATION_SEC * 1000);
  stopTimeline();
  closeSSEClients(clients);
  await delay(500);
  return clients;
}

// ---------------------------------------------------------------------------
// MODE: scalability
// ---------------------------------------------------------------------------
const SCALABILITY_TIERS = [100, 500, 1000, 5000, 10000];

async function runScalabilityTest() {
  const tiers = SCALABILITY_TIERS.filter((t) => t <= clientCount);
  if (tiers.length === 0) tiers.push(clientCount);

  console.log(`\nScalability Test: ${protocol.toUpperCase()}`);
  console.log(`Tiers: ${tiers.join(', ')} connections\n`);

  const results = [];

  for (const target of tiers) {
    globalStats.connections = 0;
    globalStats.connectionTimes = [];
    globalStats.errors = 0;

    const clients = [];
    const effectiveCount = protocol === 'sse' ? Math.min(target, SSE_MAX_CONNECTIONS) : target;

    console.log(`\n--- Tier: ${target} connections ---`);
    const connectStart = Date.now();

    if (protocol === 'websocket') {
      for (let i = 0; i < effectiveCount; i++) {
        try {
          const ws = await createWebSocketClient(i);
          clients.push(ws);
        } catch { /* counted */ }
      }
    } else {
      const batchSize = effectiveCount > 2000 ? 25 : 50;
      const batchDelay = effectiveCount > 2000 ? 200 : 50;
      for (let i = 0; i < effectiveCount; i += batchSize) {
        const batch = [];
        for (let j = 0; j < batchSize && i + j < effectiveCount; j++) {
          batch.push(createSSEClient(i + j));
        }
        const res = await Promise.all(batch);
        clients.push(...res.filter(Boolean));
        await delay(batchDelay);
      }
    }

    const connectTime = Date.now() - connectStart;
    const successRate = effectiveCount > 0 ? ((globalStats.connections / effectiveCount) * 100).toFixed(1) : 0;
    const metricsAfter = await fetchMetrics();
    const memAfter = metricsAfter?.memoryUsage ?? '-';

    results.push({
      target,
      connected: globalStats.connections,
      successRate: `${successRate}%`,
      connectTimeMs: connectTime,
      memoryUsage: memAfter,
    });

    console.log(`  Connected: ${globalStats.connections}/${effectiveCount} (${successRate}%)`);
    console.log(`  Connection time: ${connectTime}ms`);
    console.log(`  Memory: ${typeof memAfter === 'object' ? `heap ${memAfter.heapMB}MB / rss ${memAfter.rssMB}MB` : memAfter}`);

    closeClients(clients);
    await delay(1000);
  }

  console.log('\n' + '='.repeat(60));
  console.log('Scalability Test Summary');
  console.log('='.repeat(60));
  console.log(`Protocol: ${protocol.toUpperCase()}\n`);
  console.log('Tier    | Connected | Success | Connect Time | Memory');
  console.log('-'.repeat(60));
  results.forEach((r) => {
    const mem = typeof r.memoryUsage === 'object'
      ? `heap ${r.memoryUsage.heapMB}MB / rss ${r.memoryUsage.rssMB}MB`
      : r.memoryUsage;
    console.log(
      `${String(r.target).padStart(6)} | ${String(r.connected).padStart(8)} | ` +
      `${r.successRate.padStart(6)} | ${String(r.connectTimeMs + 'ms').padStart(11)} | ${mem}`
    );
  });
  console.log('='.repeat(60));
}

// ---------------------------------------------------------------------------
// MODE: echo (round-trip test)
// ---------------------------------------------------------------------------
async function runEchoTest() {
  console.log(`\nEcho Test: ${protocol.toUpperCase()} | ${clientCount} clients | ${ECHO_RATE} echoes/sec/client | ${DURATION_SEC}s\n`);

  const echoLatencies = [];
  const clients = [];

  if (protocol === 'websocket') {
    // WS echo: send { type:'echo', id, timestamp }, expect { type:'echo-reply', id, timestamp }
    for (let i = 0; i < clientCount; i++) {
      try {
        const ws = await createWebSocketClient(i, {
          onMessage: (msg) => {
            if (msg.type === 'echo-reply' && msg.timestamp) {
              const rtt = Date.now() - msg.timestamp;
              echoLatencies.push(rtt);
              globalStats.latencies.push(rtt);
              globalStats.messagesReceived++;
            }
          },
        });
        clients.push(ws);
      } catch { /* counted */ }
    }

    console.log(`Connected: ${clients.length} clients. Sending echoes...`);
    startTimeline();

    const intervalMs = 1000 / ECHO_RATE;
    const echoTimers = clients.map((ws) =>
      setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'echo', id: uuid(), timestamp: Date.now() }));
        }
      }, intervalMs)
    );

    await delay(DURATION_SEC * 1000);
    echoTimers.forEach((t) => clearInterval(t));
    stopTimeline();
    closeWSClients(clients);
  } else {
    // SSE echo: POST /echo with { clientId, id, timestamp }, receive echo via SSE stream
    for (let i = 0; i < clientCount; i++) {
      try {
        const clientId = `client-${i}`;
        const sseClient = await createSSEClient(i, {
          queryParams: { clientId },
          onMessage: (msg) => {
            if (msg.type === 'echo-reply' && msg.timestamp) {
              const rtt = Date.now() - msg.timestamp;
              echoLatencies.push(rtt);
              globalStats.latencies.push(rtt);
              globalStats.messagesReceived++;
            }
          },
        });
        if (sseClient) clients.push({ ...sseClient, clientId });
      } catch { globalStats.errors++; }
    }

    console.log(`Connected: ${clients.length} clients. Sending echoes...`);
    startTimeline();

    const intervalMs = 1000 / ECHO_RATE;
    const echoTimers = clients.map((c) =>
      setInterval(() => {
        const body = JSON.stringify({ clientId: c.clientId, id: uuid(), timestamp: Date.now() });
        const postReq = http.request(
          {
            hostname: SSE_HOST, port: SSE_PORT, path: '/echo',
            method: 'POST', family: 4,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          },
          () => {}
        );
        postReq.on('error', () => {});
        postReq.write(body);
        postReq.end();
      }, intervalMs)
    );

    await delay(DURATION_SEC * 1000);
    echoTimers.forEach((t) => clearInterval(t));
    stopTimeline();
    closeSSEClients(clients);
    await delay(500);
  }

  const percs = computePercentiles(echoLatencies);
  console.log('\n' + '='.repeat(55));
  console.log('Echo Test Results');
  console.log('='.repeat(55));
  console.log(`Protocol:       ${protocol.toUpperCase()}`);
  console.log(`Clients:        ${clients.length}`);
  console.log(`Echo rate:      ${ECHO_RATE}/sec/client`);
  console.log(`Total echoes:   ${echoLatencies.length}`);
  console.log(`RTT p50:        ${percs.p50}ms`);
  console.log(`RTT p95:        ${percs.p95}ms`);
  console.log(`RTT p99:        ${percs.p99}ms`);
  console.log(`RTT min:        ${percs.min}ms`);
  console.log(`RTT max:        ${percs.max}ms`);
  console.log(`RTT avg:        ${percs.avg}ms`);
  console.log(`RTT stddev:     ${percs.stddev}ms`);
  console.log('='.repeat(55));

  globalStats.latencies = echoLatencies;
}

// ---------------------------------------------------------------------------
// MODE: throughput (rate ramp-up)
// ---------------------------------------------------------------------------
async function runThroughputTest() {
  const rateTiers = [10, 50, 100, 200, 500, 1000];
  const tierDuration = 10; // seconds per tier

  console.log(`\nThroughput Test: ${protocol.toUpperCase()} | ${clientCount} clients`);
  console.log(`Rate tiers: ${rateTiers.join(', ')} msg/sec | ${tierDuration}s per tier\n`);

  // Connect clients
  const clients = [];
  if (protocol === 'websocket') {
    for (let i = 0; i < clientCount; i++) {
      try { clients.push(await createWebSocketClient(i)); } catch { /* counted */ }
    }
  } else {
    const sseClients = await connectSSEBatch(clientCount);
    clients.push(...sseClients);
  }
  console.log(`\nConnected: ${clients.length} clients.\n`);

  const tierResults = [];
  startTimeline();

  for (const rate of rateTiers) {
    // Configure server rate
    await postConfig({ rate });
    console.log(`  Rate: ${rate} msg/sec ...`);

    const beforeMsgs = globalStats.messagesReceived;
    const beforeLatencies = globalStats.latencies.length;
    const beforeDropped = globalStats.droppedConnections;

    await delay(tierDuration * 1000);

    const msgsThisTier = globalStats.messagesReceived - beforeMsgs;
    const latenciesThisTier = globalStats.latencies.slice(beforeLatencies);
    const droppedThisTier = globalStats.droppedConnections - beforeDropped;

    const expectedMsgs = rate * tierDuration * clients.length;
    const deliveryRatio = expectedMsgs > 0 ? (msgsThisTier / expectedMsgs) : 0;
    const percs = computePercentiles(latenciesThisTier);

    tierResults.push({
      rate,
      messagesReceived: msgsThisTier,
      deliveryRatio: Math.round(deliveryRatio * 10000) / 100,
      avgLatency: percs.avg,
      p99Latency: percs.p99,
      droppedConnections: droppedThisTier,
    });
  }

  stopTimeline();
  closeClients(clients);
  await delay(500);

  // Print table
  console.log('\n' + '='.repeat(75));
  console.log('Throughput Test Results');
  console.log('='.repeat(75));
  console.log(`Protocol: ${protocol.toUpperCase()} | Clients: ${clients.length}\n`);
  console.log('Rate    | Received   | Delivery % | Avg Latency | p99 Latency | Dropped');
  console.log('-'.repeat(75));
  tierResults.forEach((r) => {
    console.log(
      `${String(r.rate).padStart(6)} | ` +
      `${String(r.messagesReceived).padStart(9)} | ` +
      `${String(r.deliveryRatio + '%').padStart(9)} | ` +
      `${String(r.avgLatency + 'ms').padStart(10)} | ` +
      `${String(r.p99Latency + 'ms').padStart(10)} | ` +
      `${String(r.droppedConnections).padStart(6)}`
    );
  });
  console.log('='.repeat(75));
}

// ---------------------------------------------------------------------------
// MODE: payload-sweep (message size impact)
// ---------------------------------------------------------------------------
async function runPayloadSweepTest() {
  const sizes = [64, 256, 1024, 4096, 16384, 65536];
  const tierDuration = 10;

  console.log(`\nPayload Sweep: ${protocol.toUpperCase()} | ${clientCount} clients`);
  console.log(`Sizes: ${sizes.join(', ')} bytes | ${tierDuration}s per tier\n`);

  const clients = [];
  if (protocol === 'websocket') {
    for (let i = 0; i < clientCount; i++) {
      try { clients.push(await createWebSocketClient(i)); } catch { /* counted */ }
    }
  } else {
    const sseClients = await connectSSEBatch(clientCount);
    clients.push(...sseClients);
  }
  console.log(`\nConnected: ${clients.length} clients.\n`);

  const tierResults = [];
  startTimeline();

  for (const size of sizes) {
    await postConfig({ messageSize: size });
    console.log(`  Size: ${size} bytes ...`);

    const beforeMsgs = globalStats.messagesReceived;
    const beforeLatencies = globalStats.latencies.length;
    const t0 = Date.now();

    await delay(tierDuration * 1000);

    const elapsed = (Date.now() - t0) / 1000;
    const msgsThisTier = globalStats.messagesReceived - beforeMsgs;
    const latenciesThisTier = globalStats.latencies.slice(beforeLatencies);
    const percs = computePercentiles(latenciesThisTier);
    const throughputMBs = (msgsThisTier * size) / (1024 * 1024 * elapsed);

    tierResults.push({
      size,
      messagesReceived: msgsThisTier,
      avgLatency: percs.avg,
      p99Latency: percs.p99,
      throughputMBs: Math.round(throughputMBs * 1000) / 1000,
    });
  }

  stopTimeline();
  closeClients(clients);
  await delay(500);

  console.log('\n' + '='.repeat(70));
  console.log('Payload Sweep Results');
  console.log('='.repeat(70));
  console.log(`Protocol: ${protocol.toUpperCase()} | Clients: ${clients.length}\n`);
  console.log('Size     | Received   | Avg Latency | p99 Latency | Throughput MB/s');
  console.log('-'.repeat(70));
  tierResults.forEach((r) => {
    console.log(
      `${String(r.size + 'B').padStart(7)} | ` +
      `${String(r.messagesReceived).padStart(9)} | ` +
      `${String(r.avgLatency + 'ms').padStart(10)} | ` +
      `${String(r.p99Latency + 'ms').padStart(10)} | ` +
      `${String(r.throughputMBs).padStart(14)}`
    );
  });
  console.log('='.repeat(70));
}

// ---------------------------------------------------------------------------
// MODE: connection-cost (handshake overhead)
// ---------------------------------------------------------------------------
async function runConnectionCostTest() {
  console.log(`\nConnection Cost Test: ${protocol.toUpperCase()} | ${ITERATIONS} iterations\n`);

  const connectTimes = [];
  startTimeline();

  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = Date.now();

    if (protocol === 'websocket') {
      try {
        const ws = await createWebSocketClient(i, {
          onMessage: () => {}, // just wait for first message
        });
        // Wait for first message
        await new Promise((resolve) => {
          const origHandler = ws.listeners('message')[0];
          ws.removeAllListeners('message');
          ws.on('message', () => {
            const elapsed = Date.now() - t0;
            connectTimes.push(elapsed);
            resolve();
          });
          // Timeout for first message
          setTimeout(resolve, 5000);
        });
        ws.close();
      } catch {
        globalStats.errors++;
      }
    } else {
      // SSE: connect, wait for first data event, disconnect
      try {
        const result = await new Promise((resolve) => {
          const startT = Date.now();
          const req = http.get(
            {
              hostname: SSE_HOST, port: SSE_PORT, path: SSE_PATH,
              headers: { Accept: 'text/event-stream' },
              family: 4,
            },
            (res) => {
              if (res.statusCode !== 200) {
                res.resume();
                resolve(null);
                return;
              }
              res.once('data', () => {
                const elapsed = Date.now() - t0;
                connectTimes.push(elapsed);
                res.destroy();
                resolve({ elapsed });
              });
            }
          );
          req.on('error', () => resolve(null));
          setTimeout(() => { req.destroy(); resolve(null); }, 5000);
        });
        if (!result) globalStats.errors++;
      } catch {
        globalStats.errors++;
      }
    }

    if ((i + 1) % 50 === 0) process.stdout.write(`  ${i + 1}/${ITERATIONS}\r`);
    // Small delay between iterations to avoid overwhelming
    await delay(10);
  }

  stopTimeline();

  const percs = computePercentiles(connectTimes);
  globalStats.latencies = connectTimes;

  console.log('\n' + '='.repeat(55));
  console.log('Connection Cost Results');
  console.log('='.repeat(55));
  console.log(`Protocol:       ${protocol.toUpperCase()}`);
  console.log(`Iterations:     ${ITERATIONS}`);
  console.log(`Successful:     ${connectTimes.length}`);
  console.log(`Errors:         ${globalStats.errors}`);
  console.log(`p50:            ${percs.p50}ms`);
  console.log(`p95:            ${percs.p95}ms`);
  console.log(`p99:            ${percs.p99}ms`);
  console.log(`min:            ${percs.min}ms`);
  console.log(`max:            ${percs.max}ms`);
  console.log(`avg:            ${percs.avg}ms`);
  console.log(`stddev:         ${percs.stddev}ms`);
  console.log('='.repeat(55));
}

// ---------------------------------------------------------------------------
// MODE: churn (connection stability)
// ---------------------------------------------------------------------------
async function runChurnTest() {
  const steadyState = 500;
  const churnRate = 10; // connect/disconnect per second

  console.log(`\nChurn Test: ${protocol.toUpperCase()} | ~${steadyState} steady-state | churn ${churnRate}/sec | ${DURATION_SEC}s\n`);

  // Phase 1: establish steady state
  const pool = [];
  if (protocol === 'websocket') {
    for (let i = 0; i < steadyState; i++) {
      try { pool.push(await createWebSocketClient(i)); } catch { /* counted */ }
    }
  } else {
    const sseClients = await connectSSEBatch(steadyState);
    pool.push(...sseClients);
  }
  console.log(`Steady state: ${pool.length} connections. Starting churn...\n`);

  // Poll memory from server every 5 seconds
  const memorySnapshots = [];
  const memoryPoller = setInterval(async () => {
    const m = await httpGet(serverHost(), serverPort(), '/metrics', 3000);
    if (m) {
      memorySnapshots.push({
        timestamp: Date.now(),
        heapMB: m.memoryUsage?.heapMB ?? 0,
        rssMB: m.memoryUsage?.rssMB ?? 0,
        eventLoopLagMs: m.eventLoopLagMs ?? 0,
      });
    }
  }, 5000);

  startTimeline();

  // Phase 2: churn - connect and disconnect at churnRate/sec
  let clientIdCounter = steadyState;
  const churnIntervalMs = 1000 / churnRate;
  let churnRunning = true;

  const churnLoop = async () => {
    while (churnRunning) {
      // Disconnect one
      if (pool.length > 0) {
        const victim = pool.shift();
        if (protocol === 'websocket') {
          try { victim.close(); } catch { /* ignore */ }
        } else {
          try { victim?.res?.destroy(); } catch { /* ignore */ }
        }
      }

      // Connect one
      try {
        if (protocol === 'websocket') {
          const ws = await createWebSocketClient(clientIdCounter++);
          pool.push(ws);
        } else {
          const c = await createSSEClient(clientIdCounter++);
          if (c) pool.push(c);
        }
      } catch { /* counted */ }

      await delay(churnIntervalMs);
    }
  };

  const churnPromise = churnLoop();
  await delay(DURATION_SEC * 1000);
  churnRunning = false;
  await churnPromise;

  stopTimeline();
  clearInterval(memoryPoller);

  // Cleanup remaining
  closeClients(pool);
  await delay(500);

  // Memory trend
  const memStart = memorySnapshots.length > 0 ? memorySnapshots[0] : null;
  const memEnd = memorySnapshots.length > 0 ? memorySnapshots[memorySnapshots.length - 1] : null;

  console.log('\n' + '='.repeat(55));
  console.log('Churn Test Results');
  console.log('='.repeat(55));
  console.log(`Protocol:         ${protocol.toUpperCase()}`);
  console.log(`Duration:         ${DURATION_SEC}s`);
  console.log(`Churn rate:       ${churnRate} connect+disconnect/sec`);
  console.log(`Total connects:   ${globalStats.connections}`);
  console.log(`Total errors:     ${globalStats.errors}`);
  console.log(`Messages recv:    ${globalStats.messagesReceived}`);
  if (memStart && memEnd) {
    console.log(`Memory start:     heap ${memStart.heapMB}MB / rss ${memStart.rssMB}MB`);
    console.log(`Memory end:       heap ${memEnd.heapMB}MB / rss ${memEnd.rssMB}MB`);
    console.log(`Heap growth:      ${memEnd.heapMB - memStart.heapMB}MB`);
    console.log(`RSS growth:       ${memEnd.rssMB - memStart.rssMB}MB`);
  }
  if (memorySnapshots.length > 0) {
    const lagPercs = computePercentiles(memorySnapshots.map((s) => s.eventLoopLagMs));
    console.log(`Event loop lag:   avg ${lagPercs.avg}ms / p99 ${lagPercs.p99}ms`);
  }
  console.log('='.repeat(55));
}

// ---------------------------------------------------------------------------
// MODE: reconnect (recovery test)
// ---------------------------------------------------------------------------
async function runReconnectTest() {
  console.log(`\nReconnect Test: ${protocol.toUpperCase()} | ${clientCount} clients\n`);

  // Phase 1: connect all clients
  const clients = [];
  let reconnectedCount = 0;
  const reconnectLatencies = [];

  if (protocol === 'websocket') {
    for (let i = 0; i < clientCount; i++) {
      try { clients.push(await createWebSocketClient(i)); } catch { /* counted */ }
    }
  } else {
    const sseClients = await connectSSEBatch(clientCount);
    clients.push(...sseClients);
  }
  console.log(`Phase 1: ${clients.length} clients connected. Running 10s steady state...`);
  const msgsBeforeDisconnect = globalStats.messagesReceived;

  startTimeline();
  await delay(10000); // 10s steady state

  const msgsAtDisconnect = globalStats.messagesReceived;
  console.log(`  Messages during steady state: ${msgsAtDisconnect - msgsBeforeDisconnect}`);

  // Phase 2: force disconnect all
  console.log(`Phase 2: Forcing disconnect of all clients...`);
  const disconnectTime = Date.now();
  await postDisconnectAll();

  // Phase 3: reconnect
  console.log(`Phase 3: Reconnecting...`);
  const reconnectStart = Date.now();
  const reconnectedClients = [];

  if (protocol === 'websocket') {
    // WS: manual reconnect with exponential backoff
    const reconnectPromises = clients.map(async (ws, i) => {
      let backoff = 100;
      for (let attempt = 0; attempt < 5; attempt++) {
        await delay(backoff);
        try {
          const newWs = await createWebSocketClient(i);
          reconnectedClients.push(newWs);
          reconnectedCount++;
          reconnectLatencies.push(Date.now() - disconnectTime);
          return;
        } catch {
          backoff = Math.min(backoff * 2, 5000);
        }
      }
      globalStats.errors++;
    });
    await Promise.all(reconnectPromises);
  } else {
    // SSE: reconnect with Last-Event-ID style behavior
    for (let i = 0; i < clients.length; i++) {
      try {
        const c = await createSSEClient(i);
        if (c) {
          reconnectedClients.push(c);
          reconnectedCount++;
          reconnectLatencies.push(Date.now() - disconnectTime);
        }
      } catch { globalStats.errors++; }
    }
  }

  const totalReconnectTime = Date.now() - reconnectStart;

  // Brief run after reconnect to check for message loss
  const msgsAfterReconnect = globalStats.messagesReceived;
  await delay(5000);
  const msgsPostReconnect = globalStats.messagesReceived - msgsAfterReconnect;

  stopTimeline();
  closeClients(reconnectedClients);
  await delay(500);

  const percs = computePercentiles(reconnectLatencies);

  console.log('\n' + '='.repeat(55));
  console.log('Reconnect Test Results');
  console.log('='.repeat(55));
  console.log(`Protocol:            ${protocol.toUpperCase()}`);
  console.log(`Original clients:    ${clients.length}`);
  console.log(`Reconnected:         ${reconnectedCount}`);
  console.log(`Failed:              ${clients.length - reconnectedCount}`);
  console.log(`Total reconnect time: ${totalReconnectTime}ms`);
  console.log(`Reconnect p50:       ${percs.p50}ms`);
  console.log(`Reconnect p95:       ${percs.p95}ms`);
  console.log(`Reconnect p99:       ${percs.p99}ms`);
  console.log(`Msgs pre-disconnect: ${msgsAtDisconnect - msgsBeforeDisconnect}`);
  console.log(`Msgs post-reconnect: ${msgsPostReconnect} (5s window)`);
  console.log('='.repeat(55));

  globalStats.latencies = reconnectLatencies;
}

// ---------------------------------------------------------------------------
// MODE: binary (binary data test)
// ---------------------------------------------------------------------------
async function runBinaryTest() {
  console.log(`\nBinary Test: ${protocol.toUpperCase()} | ${clientCount} clients | ${DURATION_SEC}s\n`);

  // Tell server to send binary
  await postConfig({ binary: true });

  let totalBytes = 0;
  const clients = [];

  if (protocol === 'websocket') {
    for (let i = 0; i < clientCount; i++) {
      try {
        const ws = await createWebSocketClient(i, {
          onMessage: (msg) => {
            // For binary, we parse the JSON wrapper but the payload may contain binary-encoded data
            if (msg.timestamp) {
              const latency = Date.now() - msg.timestamp;
              globalStats.latencies.push(latency);
              globalStats.messagesReceived++;
            }
            // Estimate wire size for WS (raw binary frame)
            totalBytes += JSON.stringify(msg).length;
          },
        });
        clients.push(ws);
      } catch { /* counted */ }
    }
  } else {
    const sseClients = await connectSSEBatch(clientCount, {
      onMessage: (msg) => {
        if (msg.timestamp) {
          const latency = Date.now() - msg.timestamp;
          globalStats.latencies.push(latency);
          globalStats.messagesReceived++;
        }
        // SSE uses base64 for binary - estimate overhead
        const jsonSize = JSON.stringify(msg).length;
        // SSE base64 overhead is ~33%
        totalBytes += jsonSize;
      },
    });
    clients.push(...sseClients);
  }

  console.log(`Connected: ${clients.length} clients. Running for ${DURATION_SEC}s...`);
  startTimeline();
  await delay(DURATION_SEC * 1000);
  stopTimeline();

  closeClients(clients);
  await delay(500);

  // Disable binary mode
  await postConfig({ binary: false });

  const elapsed = DURATION_SEC;
  const percs = computePercentiles(globalStats.latencies);
  const throughputMBs = totalBytes / (1024 * 1024 * elapsed);

  console.log('\n' + '='.repeat(55));
  console.log('Binary Test Results');
  console.log('='.repeat(55));
  console.log(`Protocol:        ${protocol.toUpperCase()}`);
  console.log(`Clients:         ${clients.length}`);
  console.log(`Messages recv:   ${globalStats.messagesReceived}`);
  console.log(`Total data:      ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`Throughput:      ${throughputMBs.toFixed(3)} MB/s`);
  console.log(`Latency avg:     ${percs.avg}ms`);
  console.log(`Latency p99:     ${percs.p99}ms`);
  if (protocol === 'sse') {
    console.log(`Note: SSE uses base64 for binary data (~33% overhead)`);
  } else {
    console.log(`Note: WebSocket supports native binary frames`);
  }
  console.log('='.repeat(55));
}

// ---------------------------------------------------------------------------
// Print summary (for latency/broadcast modes)
// ---------------------------------------------------------------------------
async function printSummary() {
  const m = await fetchMetrics();
  const messageRate = m?.messageRate ?? '-';
  const messageSizeVal = m?.messageSize ?? MESSAGE_SIZE;
  const droppedConnections = m?.droppedConnections ?? 0;
  const mem = m?.memoryUsage;
  const memoryUsage =
    mem && typeof mem === 'object'
      ? `heap ${mem.heapMB}MB / rss ${mem.rssMB}MB`
      : (m?.memoryUsage ?? '-');
  const cpuUsagePercent = m?.cpuUsagePercent ?? '-';
  const eventLoopLagMs = m?.eventLoopLagMs ?? '-';

  const percs = computePercentiles(globalStats.latencies);
  const msgPerSec = globalStats.latencies.length > 0
    ? Math.round(globalStats.latencies.length / DURATION_SEC) : 0;

  console.log('\n' + '='.repeat(55));
  console.log('Test Summary');
  console.log('='.repeat(55));
  console.log(`Protocol:            ${protocol.toUpperCase()}`);
  console.log(`Mode:                ${MODE}`);
  console.log(`Connections:         ${globalStats.connections}`);
  console.log(`Message rate:        ${messageRate} msg/sec`);
  console.log(`Message size:        ${messageSizeVal} bytes`);
  console.log(`Messages received:   ${globalStats.messagesReceived}`);
  console.log(`Messages/sec:        ${msgPerSec}`);
  console.log(`Latency avg:         ${percs.avg}ms`);
  console.log(`Latency p50:         ${percs.p50}ms`);
  console.log(`Latency p95:         ${percs.p95}ms`);
  console.log(`Latency p99:         ${percs.p99}ms`);
  console.log(`Latency min:         ${percs.min}ms`);
  console.log(`Latency max:         ${percs.max}ms`);
  console.log(`Latency stddev:      ${percs.stddev}ms`);
  console.log(`Dropped connections: ${droppedConnections}`);
  console.log(`Memory usage:        ${memoryUsage}`);
  console.log(`CPU usage:           ${typeof cpuUsagePercent === 'number' ? cpuUsagePercent + '%' : cpuUsagePercent}`);
  console.log(`Event loop lag:      ${eventLoopLagMs}ms`);
  if (globalStats.connectionTimes.length > 0) {
    const connPercs = computePercentiles(globalStats.connectionTimes);
    console.log(`Conn time avg:       ${connPercs.avg}ms`);
    console.log(`Conn time p99:       ${connPercs.p99}ms`);
  }
  if (globalStats.errors > 0) {
    console.log(`Errors:              ${globalStats.errors}`);
  }
  console.log('='.repeat(55));
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------
async function writeJsonOutput() {
  if (!OUTPUT_FILE) return;

  const m = await fetchMetrics();
  const percs = computePercentiles(globalStats.latencies);
  const connPercs = computePercentiles(globalStats.connectionTimes);

  const result = {
    testName: `${MODE}-${clientCount}-clients`,
    protocol,
    mode: MODE,
    params: {
      clients: clientCount,
      rate: INITIAL_RATE || (m?.messageRate ?? 1),
      messageSize: MESSAGE_SIZE,
      duration: DURATION_SEC,
      echoRate: MODE === 'echo' ? ECHO_RATE : undefined,
      iterations: MODE === 'connection-cost' ? ITERATIONS : undefined,
    },
    latency: {
      p50: percs.p50,
      p95: percs.p95,
      p99: percs.p99,
      min: percs.min,
      max: percs.max,
      avg: percs.avg,
      stddev: percs.stddev,
    },
    throughput: {
      messagesReceived: globalStats.messagesReceived,
      msgPerSec: DURATION_SEC > 0
        ? Math.round(globalStats.messagesReceived / DURATION_SEC)
        : 0,
    },
    connections: {
      established: globalStats.connections,
      dropped: globalStats.droppedConnections,
      errors: globalStats.errors,
      avgConnectTimeMs: connPercs.avg,
    },
    resources: m ? {
      memoryUsage: m.memoryUsage,
      cpuUsagePercent: m.cpuUsagePercent,
      eventLoopLagMs: m.eventLoopLagMs,
    } : {},
    timeline,
    timestamp: new Date().toISOString(),
  };

  // Remove undefined params
  Object.keys(result.params).forEach((k) => {
    if (result.params[k] === undefined) delete result.params[k];
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\nJSON results written to: ${OUTPUT_FILE}`);
}

// ---------------------------------------------------------------------------
// Usage help
// ---------------------------------------------------------------------------
function printUsage() {
  console.log(`
Usage: node client-simulator.js [websocket|sse] [client_count] [flags]

Modes (--mode=MODE):
  latency          Passive receive: measure delivery latency (default)
  broadcast        Passive receive: measure broadcast fan-out
  scalability      Progressive connection tiers up to client_count
  echo             Round-trip echo test (--echo-rate=N)
  throughput       Rate ramp-up: 10, 50, 100, 200, 500, 1000 msg/sec
  payload-sweep    Message size sweep: 64B to 64KB
  connection-cost  Handshake overhead (--iterations=N)
  churn            Connection stability under churn
  reconnect        Recovery after mass disconnect
  binary           Binary data throughput test

Flags:
  --duration=N          Test duration in seconds (default: 30)
  --mode=MODE           Test mode (see above)
  --message-size=N      Message size in bytes (default: 64)
  --echo-rate=N         Echoes/sec/client for echo mode (default: 10)
  --rate=N              Initial server message rate
  --iterations=N        Iterations for connection-cost (default: 500)
  --max-connections=N   Max SSE connections (default: 2000)
  --output=FILE         Write structured JSON results to file

Examples:
  node client-simulator.js websocket 1000 --mode=latency --duration=30
  node client-simulator.js sse 500 --mode=echo --echo-rate=20
  node client-simulator.js websocket 100 --mode=throughput --output=results.json
  node client-simulator.js sse 1 --mode=connection-cost --iterations=1000
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (protocol !== 'websocket' && protocol !== 'sse') {
    printUsage();
    process.exit(1);
  }

  // Check server health
  await ensureServerUp();

  // POST /reset to clear server metrics before test
  await postReset();

  // Set initial rate if specified
  if (INITIAL_RATE > 0) {
    await postConfig({ rate: INITIAL_RATE });
    console.log(`Set server message rate to ${INITIAL_RATE} msg/sec`);
  }

  // Dispatch to the appropriate test mode
  switch (MODE) {
    case 'scalability':
      await runScalabilityTest();
      break;

    case 'echo':
      await runEchoTest();
      break;

    case 'throughput':
      await runThroughputTest();
      break;

    case 'payload-sweep':
      await runPayloadSweepTest();
      break;

    case 'connection-cost':
      await runConnectionCostTest();
      break;

    case 'churn':
      await runChurnTest();
      break;

    case 'reconnect':
      await runReconnectTest();
      break;

    case 'binary':
      await runBinaryTest();
      break;

    case 'latency':
    case 'broadcast':
    default: {
      console.log(
        `\nLoad Test: ${protocol.toUpperCase()} | ${clientCount} clients | ` +
        `${DURATION_SEC}s | mode=${MODE} | msg-size=${MESSAGE_SIZE}B\n`
      );
      if (protocol === 'websocket') {
        await runWebSocketTest();
      } else {
        await runSSETest();
      }
      await printSummary();
      break;
    }
  }

  // Write JSON output if requested
  await writeJsonOutput();
}

main();
