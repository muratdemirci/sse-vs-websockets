# Realtime Benchmark: SSE vs WebSockets

A Node.js project that benchmarks **Server-Sent Events (SSE)** and **WebSockets** performance, comparing latency, throughput, concurrent connections, CPU usage, and memory usage.

## Benchmark Methodology

The benchmark is designed to fairly compare both protocols in realistic scenarios:

- **WebSockets** – Optimized for bidirectional, low-latency communication. Best when clients send and receive frequently.
- **SSE** – Optimized for large-scale server-to-client streaming. Best when many passive clients receive broadcasts with minimal client traffic.

### Test Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **Latency** | Clients connect, receive messages, and report latency back to the server. | Measures end-to-end latency and bidirectional overhead. |
| **Broadcast** | Passive clients only receive; no latency reports sent. | Measures pure broadcast efficiency (server → many clients). |
| **Scalability** | Progressive connection test at 100, 500, 1000, 5000, 10000 clients. | Measures connection success rate, memory, and connection time. |

### Fairness Guarantees

Both protocols use identical test conditions:

- **Same message rate** – Configurable via `--rate=N` (default 1 msg/sec)
- **Same payload** – Single JSON payload serialized once per broadcast, reused for all clients
- **Same timestamp** – Server-side `Date.now()` set once per broadcast; all clients receive identical timestamp
- **Same broadcast loop** – Non-blocking batched writes; no per-client `JSON.stringify` calls

### Limitations of Latency-Only Comparisons

- **WebSockets typically win** in latency benchmarks due to lower per-message framing overhead and bidirectional design.
- **SSE may perform better** in large-scale broadcast scenarios (many passive clients, server→client only).
- Latency is measured as `Date.now() - msg.timestamp`; run on localhost to minimize clock drift.

### Why SSE May Perform Better in Large Broadcast Scenarios

- **HTTP semantics** – SSE uses standard HTTP, so proxies, CDNs, and load balancers handle it well. WebSockets require special upgrade handling.
- **Lower per-connection overhead** – SSE connections are simpler; no upgrade handshake or frame framing per message.
- **Built-in reconnection** – Browsers automatically reconnect SSE; WebSockets need custom logic.
- **One-way streaming** – When clients only receive, SSE avoids the overhead of bidirectional framing and client→server traffic.

## Tech Stack

- **Backend:** Node.js, Express, ws (WebSocket library)
- **Frontend:** Plain HTML, Vanilla JavaScript, Chart.js
- **No frameworks** (React, Vue, etc.)

## Project Structure

```
realtime-benchmark/
├── server/
│   ├── websocket-server.js   # WebSocket server (port 3001)
│   ├── sse-server.js         # SSE server (port 3002)
│   ├── metrics.js            # Shared metrics collection
│   └── static-server.js      # Serves dashboard (port 3000)
├── client/
│   └── dashboard.html        # Unified dashboard with load test
├── load-test/
│   └── client-simulator.js   # CLI load testing (optional)
├── package.json
└── README.md
```

## Installation

```bash
npm install
```

## Quick Start (All-in-One)

Run backend (WebSocket + SSE servers) and client (static file server) with one command:

```bash
npm start
```

Then open **http://localhost:3000** and click **Run Test** to benchmark.

## Running the Servers (Individually)

### WebSocket Server (port 3001)

```bash
node server/websocket-server.js
```

Options: `--rate=N`, `--message-size=N`

```bash
node server/websocket-server.js --rate=10 --message-size=1024
```

### SSE Server (port 3002)

```bash
node server/sse-server.js
```

Options: `--rate=N`, `--message-size=N`

```bash
node server/sse-server.js --rate=10 --message-size=1024
```

### Static File Server (port 3000)

Serves the dashboard:

```bash
node server/static-server.js
```

Then open http://localhost:3000

## Dashboard

The dashboard provides:
- **Real-time metrics** – connections, latency, messages/sec, memory, CPU (updates every 2 seconds)
- **Load Test** – Run Test button to benchmark with 100, 1000, 5000, or 10000 clients
- **Protocol switch** – Toggle between WebSocket and SSE metrics
- **Charts** – Latency over time visualization

## CLI Load Testing

Simulates many clients connecting to either server and measures performance.

**Usage:**

```bash
node load-test/client-simulator.js <protocol> <client_count> [options]
```

**Options:** `--duration=N`, `--mode=latency|broadcast|scalability`, `--message-size=N`

**Examples:**

```bash
# Latency test (default)
node load-test/client-simulator.js websocket 1000
node load-test/client-simulator.js sse 1000

# Broadcast test – passive clients, no latency reports
node load-test/client-simulator.js websocket 5000 --mode=broadcast
node load-test/client-simulator.js sse 5000 --mode=broadcast

# Scalability test – progressive 100, 500, 1000, 5000, 10000
node load-test/client-simulator.js websocket 10000 --mode=scalability
node load-test/client-simulator.js sse 10000 --mode=scalability

# Custom message size (server must use same --message-size)
node load-test/client-simulator.js websocket 1000 --message-size=4096 --duration=60
```

**Example output:**

```
Test Summary
=======================================================
Protocol:          WEBSOCKET
Connections:       1000
Message rate:      1 msg/sec
Message size:      64 bytes
Messages received: 60000
Average latency:   18ms
Min latency:       5ms
Max latency:       40ms
Dropped connections: 0
Memory usage:      350MB
CPU usage:         25%
Event loop lag:    2ms
Avg connection time: 12ms
=======================================================
```

## Metrics API

Both servers expose `GET /metrics`:

- **WebSocket:** http://localhost:3001/metrics
- **SSE:** http://localhost:3002/metrics

Fields: `connections`, `messagesSent`, `messagesPerSecond`, `avgLatency`, `memoryUsage` (heapMB, rssMB), `cpuUsagePercent`, `eventLoopLagMs`, `droppedConnections`, `messageRate`, `messageSize`

## Message Format

Both servers broadcast messages with a server-side timestamp:

```json
{
  "timestamp": 1234567890123,
  "message": "test"
}
```

Clients calculate latency as `Date.now() - timestamp`. For accurate results, run tests on localhost to minimize clock drift.

## License

MIT
