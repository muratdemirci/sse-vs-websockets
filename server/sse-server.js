/**
 * Server-Sent Events (SSE) server for benchmark testing.
 * Broadcasts messages at configurable rate (default: 1/sec).
 * Port: 3002
 */

const crypto = require('crypto');
const express = require('express');
const metrics = require('./metrics');

const PORT = 3002;
const app = express();

// CORS for dashboard (cross-origin from localhost:3000)
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json());

// Parse --rate=N from command line
function parseRate() {
  const arg = process.argv.find((a) => a.startsWith('--rate='));
  if (arg) {
    const rate = parseInt(arg.split('=')[1], 10);
    return isNaN(rate) || rate < 1 ? 1 : Math.min(rate, 1000);
  }
  return 1;
}

// Parse --message-size=N (bytes)
function parseMessageSize() {
  const arg = process.argv.find((a) => a.startsWith('--message-size='));
  if (arg) {
    const size = parseInt(arg.split('=')[1], 10);
    return isNaN(size) || size < 16 ? 64 : Math.min(size, 65536);
  }
  return 64;
}

// Parse --binary flag
function parseBinary() {
  return process.argv.includes('--binary');
}

let messageRate = parseRate();
let messageSize = parseMessageSize();
let binaryMode = parseBinary();
let broadcastInterval = null;

// Event ID counter
let eventId = 0;

// Ring buffer for Last-Event-ID replay
const EVENT_BUFFER_SIZE = 1000;
const eventBuffer = [];

function startBroadcast() {
  if (broadcastInterval) clearInterval(broadcastInterval);
  const intervalMs = 1000 / messageRate;
  broadcastInterval = setInterval(broadcast, intervalMs);
}

// Cached padding to avoid repeated allocations (per message size)
let cachedPad = '';
let cachedPadSize = 0;

// Cached binary buffer for binary mode
let cachedBinaryBuffer = null;
let cachedBinarySize = 0;

function createPayload() {
  if (binaryMode) {
    if (cachedBinarySize !== messageSize) {
      cachedBinaryBuffer = crypto.randomBytes(messageSize);
      cachedBinarySize = messageSize;
    }
    return cachedBinaryBuffer.toString('base64');
  }

  const timestamp = Date.now();
  const base = { timestamp, message: 'test' };
  const baseJson = JSON.stringify(base);
  const needLen = messageSize - baseJson.length;
  if (needLen <= 0) return { timestamp, message: 'test' };
  if (cachedPadSize !== needLen) {
    cachedPad = 'x'.repeat(needLen);
    cachedPadSize = needLen;
  }
  return { timestamp, message: 'test', _pad: cachedPad };
}

// Store all connected SSE clients (anonymous)
const clients = new Set();

// Map of clientId -> res for echo routing
const clientMap = new Map();

// Metrics endpoint
app.get('/metrics', (req, res) => {
  const m = metrics.getMetrics();
  m.messageRate = messageRate;
  m.messageSize = messageSize;
  m.binaryMode = binaryMode;
  res.json(m);
});

app.post('/rate', (req, res) => {
  const rate = Math.max(1, Math.min(1000, parseInt(req.body?.rate, 10) || 1));
  messageRate = rate;
  startBroadcast();
  res.json({ rate: messageRate });
});

app.post('/latency', (req, res) => {
  const { latency } = req.body;
  metrics.recordLatency(latency);
  res.status(204).end();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Reset metrics, eventId, and event buffer
app.post('/reset', (req, res) => {
  metrics.resetMetrics();
  eventId = 0;
  eventBuffer.length = 0;
  res.json({ reset: true });
});

// Disconnect all SSE clients
app.post('/disconnect-all', (req, res) => {
  const count = clients.size;
  for (const client of clients) {
    try {
      client.destroy();
    } catch (_) {
      // ignore
    }
  }
  clients.clear();
  clientMap.clear();
  res.json({ disconnected: count });
});

// Batch config update
app.post('/config', (req, res) => {
  const { rate, messageSize: size, binary } = req.body || {};
  if (rate !== undefined) {
    messageRate = Math.max(1, Math.min(1000, parseInt(rate, 10) || 1));
  }
  if (size !== undefined) {
    const parsed = parseInt(size, 10);
    messageSize = isNaN(parsed) || parsed < 16 ? 64 : Math.min(parsed, 65536);
    // Invalidate cached padding/binary
    cachedPadSize = 0;
    cachedBinarySize = 0;
  }
  if (binary !== undefined) {
    binaryMode = !!binary;
    cachedBinarySize = 0;
  }
  startBroadcast();
  res.json({ rate: messageRate, messageSize, binaryMode });
});

// Echo endpoint: send event back to a specific client
app.post('/echo', (req, res) => {
  const { clientId, id, timestamp } = req.body || {};
  if (!clientId) {
    return res.status(400).json({ error: 'clientId is required' });
  }
  const clientRes = clientMap.get(clientId);
  if (!clientRes) {
    return res.status(404).json({ error: 'client not found' });
  }
  const echoData = JSON.stringify({ type: 'echo-reply', id, timestamp });
  const echoMessage = `event: echo\ndata: ${echoData}\n\n`;
  try {
    const ok = clientRes.write(echoMessage);
    if (ok) {
      metrics.recordBytesSent(echoMessage.length);
      if (typeof clientRes.flush === 'function') clientRes.flush();
    }
    res.json({ echoed: true });
  } catch (err) {
    res.status(500).json({ error: 'failed to write to client' });
  }
});

// SSE endpoint - anti-buffering headers for low latency
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Disable Nagle's algorithm for fair comparison with WebSocket
  if (res.socket) {
    res.socket.setNoDelay(true);
  }

  // Send retry field for configurable reconnection delay
  res.write('retry: 1000\n\n');

  metrics.addConnection();
  clients.add(res);

  // Track connection start time
  const connectedAt = Date.now();

  // Register clientId if provided
  const clientId = req.query.clientId;
  if (clientId) {
    clientMap.set(clientId, res);
  }

  // Replay missed events if Last-Event-ID is provided
  const lastEventId = parseInt(req.headers['last-event-id'], 10);
  if (lastEventId && !isNaN(lastEventId)) {
    const missed = eventBuffer.filter((e) => e.id > lastEventId);
    missed.forEach((e) => {
      const replayMsg = `id: ${e.id}\ndata: ${e.data}\n\n`;
      res.write(replayMsg);
      metrics.recordBytesSent(replayMsg.length);
    });
  }

  // Send initial event
  const payload = createPayload();
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const currentId = ++eventId;
  const initialMessage = `id: ${currentId}\ndata: ${payloadStr}\n\n`;
  res.write(initialMessage);
  metrics.recordBytesSent(initialMessage.length);
  if (typeof res.flush === 'function') res.flush();

  // Store in ring buffer
  eventBuffer.push({ id: currentId, data: payloadStr });
  if (eventBuffer.length > EVENT_BUFFER_SIZE) {
    eventBuffer.shift();
  }

  req.on('close', () => {
    clients.delete(res);
    if (clientId) {
      clientMap.delete(clientId);
    }
    metrics.removeConnection();
    metrics.recordConnectionTime(Date.now() - connectedAt);
  });
});

// Broadcast: serialize payload once per broadcast, reuse for all clients
const BATCH_SIZE = 100;
function broadcast() {
  const payload = createPayload();
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const currentId = ++eventId;
  const message = `id: ${currentId}\ndata: ${payloadStr}\n\n`;

  // Store in ring buffer
  eventBuffer.push({ id: currentId, data: payloadStr });
  if (eventBuffer.length > EVENT_BUFFER_SIZE) {
    eventBuffer.shift();
  }

  const clientList = Array.from(clients);

  function sendBatch(offset) {
    const batch = clientList.slice(offset, offset + BATCH_SIZE);
    batch.forEach((res) => {
      try {
        const ok = res.write(message);
        if (ok) {
          metrics.recordMessageSent();
          metrics.recordBytesSent(message.length);
        } else {
          clients.delete(res);
          metrics.removeConnection();
          metrics.recordDroppedConnection();
        }
      } catch (err) {
        clients.delete(res);
        metrics.removeConnection();
        metrics.recordDroppedConnection();
      }
    });
    const nextOffset = offset + BATCH_SIZE;
    if (nextOffset < clientList.length) {
      setImmediate(() => sendBatch(nextOffset));
    }
  }

  if (clientList.length > 0) sendBatch(0);
}

startBroadcast();

app.listen(PORT, () => {
  console.log(`SSE server running on http://localhost:${PORT}`);
  console.log(`Events endpoint: http://localhost:${PORT}/events`);
  console.log(`Message rate: ${messageRate} msg/sec (POST /rate to change)`);
  console.log(`Message size: ${messageSize} bytes`);
  console.log(`Binary mode: ${binaryMode}`);
  console.log(`Metrics: http://localhost:${PORT}/metrics`);
});
