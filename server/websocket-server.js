/**
 * WebSocket server for benchmark testing.
 * Broadcasts messages at configurable rate (default: 1/sec).
 * Port: 3001
 *
 * CLI flags:
 *   --rate=N           Messages per second (1-1000, default: 1)
 *   --message-size=N   Payload size in bytes (16-65536, default: 64)
 *   --mode=echo        Echo mode: replies to echo requests instead of broadcasting
 *   --binary           Send binary Buffer payloads instead of JSON strings
 */

const WebSocket = require('ws');
const http = require('http');
const metrics = require('./metrics');

const PORT = 3001;

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

// Parse --mode=echo
function parseMode() {
  const arg = process.argv.find((a) => a.startsWith('--mode='));
  if (arg) {
    return arg.split('=')[1] || 'broadcast';
  }
  return 'broadcast';
}

let messageRate = parseRate();
let messageSize = parseMessageSize();
let serverMode = parseMode();
let binaryMode = process.argv.includes('--binary');
let broadcastInterval = null;

function startBroadcast() {
  if (broadcastInterval) clearInterval(broadcastInterval);
  if (serverMode === 'echo') return; // No timer in echo mode
  const intervalMs = 1000 / messageRate;
  broadcastInterval = setInterval(broadcast, intervalMs);
}

// CORS headers shared across all endpoints
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Read the full request body as a string.
 */
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  // Handle OPTIONS preflight for all POST endpoints
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // GET /metrics
  if (req.url === '/metrics' && req.method === 'GET') {
    const m = metrics.getMetrics();
    m.messageRate = messageRate;
    m.messageSize = messageSize;
    m.serverMode = serverMode;
    m.binaryMode = binaryMode;
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(m));
    return;
  }

  // GET /health
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // POST /rate
  if (req.url === '/rate' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { rate } = JSON.parse(body || '{}');
      const newRate = Math.max(1, Math.min(1000, parseInt(rate, 10) || 1));
      messageRate = newRate;
      startBroadcast();
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rate: messageRate }));
    } catch {
      res.writeHead(400, corsHeaders);
      res.end(JSON.stringify({ error: 'Invalid rate' }));
    }
    return;
  }

  // POST /reset
  if (req.url === '/reset' && req.method === 'POST') {
    metrics.resetMetrics();
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /disconnect-all
  if (req.url === '/disconnect-all' && req.method === 'POST') {
    let count = 0;
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(1000, 'Server disconnect-all');
        count++;
      }
    });
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ disconnected: count }));
    return;
  }

  // POST /config
  if (req.url === '/config' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const config = JSON.parse(body || '{}');
      if (config.rate !== undefined) {
        messageRate = Math.max(1, Math.min(1000, parseInt(config.rate, 10) || 1));
      }
      if (config.messageSize !== undefined) {
        const size = parseInt(config.messageSize, 10);
        messageSize = isNaN(size) || size < 16 ? 64 : Math.min(size, 65536);
      }
      if (config.binary !== undefined) {
        binaryMode = !!config.binary;
      }
      startBroadcast();
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rate: messageRate, messageSize, binaryMode }));
    } catch {
      res.writeHead(400, corsHeaders);
      res.end(JSON.stringify({ error: 'Invalid config' }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  metrics.addConnection();
  const connectedAt = Date.now();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Latency reports from clients
      if (msg.type === 'latency' && typeof msg.latency === 'number') {
        metrics.recordLatency(msg.latency);
      }

      // Echo mode: reply immediately with original timestamp
      if (msg.type === 'echo') {
        const reply = JSON.stringify({ type: 'echo-reply', id: msg.id, timestamp: msg.timestamp });
        ws.send(reply);
        metrics.recordMessageSent();
        metrics.recordBytesSent(reply.length);
        if (typeof ws.bufferedAmount === 'number') {
          metrics.recordBufferedAmount(ws.bufferedAmount);
        }
      }
    } catch {
      // Ignore non-JSON or invalid messages
    }
  });

  ws.on('close', () => {
    metrics.removeConnection();
    metrics.recordConnectionTime(Date.now() - connectedAt);
  });
});

// Cached padding to avoid repeated allocations
let cachedPad = '';
let cachedPadSize = 0;

function createPayload() {
  const timestamp = Date.now();

  if (binaryMode) {
    // Binary payload: first 8 bytes = timestamp (as two 32-bit ints), rest = padding
    const buf = Buffer.alloc(Math.max(16, messageSize));
    // Write timestamp as high 32 bits + low 32 bits (big-endian)
    buf.writeUInt32BE(Math.floor(timestamp / 0x100000000), 0);
    buf.writeUInt32BE(timestamp >>> 0, 4);
    return buf;
  }

  const base = { timestamp, message: 'test' };
  const baseJson = JSON.stringify(base);
  const needLen = messageSize - baseJson.length;
  if (needLen <= 0) return JSON.stringify({ timestamp, message: 'test' });
  if (cachedPadSize !== needLen) {
    cachedPad = 'x'.repeat(needLen);
    cachedPadSize = needLen;
  }
  const payloadStr = JSON.stringify({ timestamp, message: 'test', _pad: cachedPad });
  return payloadStr;
}

// Non-blocking broadcast - process in batches to avoid event loop blocking
const BATCH_SIZE = 100;
function broadcast() {
  const payload = createPayload();
  const payloadLength = binaryMode ? payload.length : Buffer.byteLength(payload);
  const clientList = Array.from(wss.clients).filter((c) => c.readyState === WebSocket.OPEN);

  function sendBatch(offset) {
    const batch = clientList.slice(offset, offset + BATCH_SIZE);
    batch.forEach((client) => {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
          metrics.recordMessageSent();
          metrics.recordBytesSent(payloadLength);
          if (typeof client.bufferedAmount === 'number') {
            metrics.recordBufferedAmount(client.bufferedAmount);
          }
        }
      } catch (err) {
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

server.listen(PORT, () => {
  console.log(`WebSocket server running on ws://localhost:${PORT}`);
  console.log(`Mode: ${serverMode} | Rate: ${messageRate} msg/sec | Size: ${messageSize} bytes | Binary: ${binaryMode}`);
  console.log(`Endpoints: GET /metrics | GET /health | POST /rate | POST /reset | POST /disconnect-all | POST /config`);
});
