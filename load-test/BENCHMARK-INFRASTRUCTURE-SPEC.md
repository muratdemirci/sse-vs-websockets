# SSE vs WebSocket Benchmark Suite - Infrastructure Specification

## Table of Contents
1. [Shell Script Design (`run-benchmarks.sh`)](#1-shell-script-design)
2. [Results Collection Strategy](#2-results-collection-strategy)
3. [Environment Consistency Checklist](#3-environment-consistency-checklist)
4. [New npm Scripts](#4-new-npm-scripts)
5. [Missing Metrics in `metrics.js`](#5-missing-metrics-in-metricsjs)

---

## 1. Shell Script Design

### File: `load-test/run-benchmarks.sh`

### 1.1 Test Profiles

Three profiles controlling scope and duration:

| Profile | Clients | Duration/test | Runs/scenario | Total est. time |
|---|---|---|---|---|
| `quick` | 100, 500 | 15s | 1 | ~5 min |
| `standard` | 100, 500, 1000, 2000 | 30s | 3 | ~30 min |
| `comprehensive` | 100, 500, 1000, 2000, 5000 | 60s | 5 | ~3 hours |

Usage:
```
./load-test/run-benchmarks.sh [quick|standard|comprehensive]
```

### 1.2 Script Structure (Pseudocode)

```bash
#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-standard}"
RESULTS_DIR="./results/$(date +%Y%m%d_%H%M%S)"
NODE_FLAGS="--max-old-space-size=4096 --expose-gc"

# --- Profile configuration ---
case "$PROFILE" in
  quick)
    CLIENT_COUNTS=(100 500)
    DURATION=15
    RUNS=1
    MESSAGE_RATES=(1 10)
    MESSAGE_SIZES=(64 1024)
    WARMUP_SEC=5
    ;;
  standard)
    CLIENT_COUNTS=(100 500 1000 2000)
    DURATION=30
    RUNS=3
    MESSAGE_RATES=(1 10 50)
    MESSAGE_SIZES=(64 512 4096)
    WARMUP_SEC=10
    ;;
  comprehensive)
    CLIENT_COUNTS=(100 500 1000 2000 5000)
    DURATION=60
    RUNS=5
    MESSAGE_RATES=(1 5 10 25 50 100)
    MESSAGE_SIZES=(64 256 512 1024 4096 16384)
    WARMUP_SEC=15
    ;;
esac

mkdir -p "$RESULTS_DIR"

# --- Functions ---

preflight_checks()
  # Verify Node.js version >= 18
  # Verify no other processes on ports 3001/3002
  # Verify ulimit -n >= 10240
  # Log system info (OS, CPU, RAM, Node version) to $RESULTS_DIR/environment.json

start_server(protocol, rate, message_size)
  # Start server with NODE_FLAGS and given --rate= --message-size=
  # Capture PID into SERVER_PID
  # Wait for /metrics endpoint to return 200 (poll every 500ms, timeout 10s)
  # Log server start to stdout

stop_server()
  # Send SIGTERM to SERVER_PID
  # Wait up to 5s for graceful shutdown
  # If still alive, SIGKILL
  # Wait 2s for port release (check with lsof)
  # Unset SERVER_PID

collect_server_metrics(output_file)
  # curl /metrics endpoint and append JSON line to output_file
  # Called at: before test, during test (every 5s via background loop), after test

run_single_test(protocol, clients, duration, rate, msg_size, run_number)
  # 1. Start server
  # 2. Warmup: run WARMUP_SEC with 10 clients, discard results
  # 3. Start background metrics collector (every 5s)
  # 4. Run client-simulator.js with args, capture stdout to log file
  # 5. Collect final server metrics
  # 6. Stop background collector
  # 7. Stop server
  # 8. Wait 3s for clean state
  # 9. Parse results into JSON, append to results CSV

run_scenario(protocol, clients, rate, msg_size)
  # For run in 1..RUNS:
  #   run_single_test(...)
  # Compute mean/stddev across runs for each metric

# --- Main execution loop ---

preflight_checks

# Test matrix: protocol x clients x rate x message_size
for protocol in websocket sse; do
  for clients in "${CLIENT_COUNTS[@]}"; do
    for rate in "${MESSAGE_RATES[@]}"; do
      for msg_size in "${MESSAGE_SIZES[@]}"; do
        run_scenario "$protocol" "$clients" "$rate" "$msg_size"
      done
    done
  done
done

# Scalability tests (separate pass)
for protocol in websocket sse; do
  start_server "$protocol" 1 64
  node $NODE_FLAGS load-test/client-simulator.js "$protocol" \
    "${CLIENT_COUNTS[-1]}" --mode=scalability --duration=$DURATION \
    > "$RESULTS_DIR/scalability_${protocol}.log" 2>&1
  collect_server_metrics "$RESULTS_DIR/scalability_${protocol}_metrics.json"
  stop_server
done

# Generate summary
generate_summary  # Merge all per-test JSONs into final CSV + summary JSON
```

### 1.3 Server Lifecycle Management

Key design decisions:

- **Full restart between every test scenario** (not just between protocols). This ensures no memory leaks, GC pressure, or connection state carries over.
- **Port availability check** after server stop: use `lsof -i :$PORT` or `nc -z localhost $PORT` with a retry loop before starting the next server.
- **PID file approach**: write server PID to `$RESULTS_DIR/.server.pid` for reliable cleanup, including a trap handler for SIGINT/SIGTERM on the script itself.
- **Trap handler**: `trap cleanup EXIT` that kills any lingering server processes and background collectors.

### 1.4 Output File Layout

```
results/
  20260323_143000/
    environment.json           # System info snapshot
    raw/
      ws_100c_1r_64b_run1.json
      ws_100c_1r_64b_run2.json
      ...
      sse_100c_1r_64b_run1.json
      ...
    server_metrics/
      ws_100c_1r_64b_run1_timeline.jsonl   # One JSON object per 5s sample
      ...
    scalability_websocket.log
    scalability_sse.log
    summary.csv                # All scenarios, one row per (protocol, clients, rate, size)
    summary.json               # Same data, structured for programmatic consumption
```

---

## 2. Results Collection Strategy

### 2.1 Server-Side Metrics Collection

**What to capture** (per 5-second sample during test):

| Metric | Source | Method |
|---|---|---|
| Heap used (MB) | `process.memoryUsage().heapUsed` | GET /metrics |
| RSS (MB) | `process.memoryUsage().rss` | GET /metrics |
| External memory (MB) | `process.memoryUsage().external` | GET /metrics (currently missing) |
| Array buffers (MB) | `process.memoryUsage().arrayBuffers` | GET /metrics (currently missing) |
| CPU % | `process.cpuUsage()` | GET /metrics (exists) |
| Event loop lag (ms) | setInterval drift | GET /metrics (exists) |
| Active connections | Counter | GET /metrics (exists) |
| Messages sent (total) | Counter | GET /metrics (exists) |
| Messages/sec | Delta counter | GET /metrics (exists) |
| Dropped connections | Counter | GET /metrics (exists) |
| GC pause time (ms) | `--expose-gc` + `perf_hooks` | GET /metrics (currently missing) |

**Collection method**: A background loop in the shell script calls `curl -s http://localhost:$PORT/metrics` every 5 seconds and appends the JSON response (plus a wall-clock timestamp) as a JSONL line to a timeline file.

**Post-process**: For each timeline, compute:
- Peak memory (max RSS across all samples)
- Average CPU %
- Max event loop lag
- Memory growth rate (linear regression on RSS over time)

### 2.2 Client-Side Metrics Collection

**Current state**: The client-simulator already tracks latencies array, connectionTimes array, messagesReceived, errors, and droppedConnections. However, it only prints a human-readable summary.

**Required changes to client-simulator.js** (design only):

Add a `--output=<filepath>` CLI flag. When present, write a structured JSON results file at test end:

```json
{
  "protocol": "websocket",
  "clientCount": 1000,
  "duration": 30,
  "mode": "latency",
  "messageSize": 64,
  "timestamp": "2026-03-23T14:30:00.000Z",
  "connections": {
    "attempted": 1000,
    "successful": 998,
    "errors": 2,
    "dropped": 0,
    "avgConnectionTimeMs": 12,
    "p50ConnectionTimeMs": 10,
    "p95ConnectionTimeMs": 25,
    "p99ConnectionTimeMs": 45,
    "maxConnectionTimeMs": 120
  },
  "latency": {
    "samples": 29400,
    "avgMs": 3,
    "minMs": 1,
    "maxMs": 45,
    "p50Ms": 2,
    "p75Ms": 3,
    "p90Ms": 5,
    "p95Ms": 8,
    "p99Ms": 22,
    "p999Ms": 40,
    "stddevMs": 4.2
  },
  "throughput": {
    "totalMessages": 29400,
    "messagesPerSec": 980,
    "totalBytesReceived": 1881600,
    "bytesPerSec": 62720
  },
  "timeline": [
    { "t": 0, "activeConns": 1000, "msgsThisBucket": 980, "avgLatencyMs": 3 },
    { "t": 5, "activeConns": 1000, "msgsThisBucket": 985, "avgLatencyMs": 3 },
    ...
  ]
}
```

**Timeline buckets** (5-second intervals during the test) enable charting latency/throughput drift over time and detecting warmup artifacts.

### 2.3 Output Format for Chart Generation

**Primary format: CSV** (`summary.csv`)

Columns:
```
protocol, clients, rate, message_size, run, avg_latency_ms, p50_latency_ms, p95_latency_ms, p99_latency_ms, max_latency_ms, latency_stddev, connection_time_avg_ms, connection_time_p95_ms, messages_per_sec, bytes_per_sec, connections_successful, connections_failed, dropped_connections, heap_mb_peak, rss_mb_peak, cpu_percent_avg, event_loop_lag_max_ms, gc_pause_total_ms
```

This CSV is directly ingestible by:
- Python (pandas/matplotlib/seaborn)
- R (ggplot2)
- Observable / D3.js
- Google Sheets / Excel pivot tables

**Secondary format: JSON** (`summary.json`) -- same data, nested by protocol > scenario for programmatic access.

### 2.4 Ensuring Statistical Significance

| Technique | Implementation |
|---|---|
| **Multiple runs** | `standard` profile: 3 runs per scenario; `comprehensive`: 5 runs |
| **Warmup period** | Before each test run, connect 10 clients for WARMUP_SEC seconds, then disconnect and discard. This primes JIT, TCP stack, and memory allocator. |
| **Cooldown between runs** | 3-second pause after server stop before next start. Prevents port reuse issues and lets OS reclaim resources. |
| **Outlier detection** | In post-processing: flag runs where any metric deviates >2 standard deviations from the mean across runs. Log a warning but keep the data. |
| **Discard first/last 10%** | When computing per-run percentiles, trim the first and last 10% of latency samples (sorted by collection time, not value). The first samples include connection-phase jitter; the last may include shutdown artifacts. |
| **Report confidence intervals** | In the summary CSV, include columns for mean, stddev, and 95% CI for latency and throughput metrics across runs. |
| **Monotonic timestamps** | Use `process.hrtime.bigint()` instead of `Date.now()` for latency measurement (sub-millisecond precision, not subject to clock drift). This is a code change recommendation. |

---

## 3. Environment Consistency Checklist

### 3.1 OS Settings

The `preflight_checks()` function in the shell script should verify and log all of these.

#### File Descriptor Limits
```bash
# Check current limit
ulimit -n
# Required: >= 10240 for 5000-client tests
# Recommendation: set to 65536

# macOS (temporary, current session):
ulimit -n 65536

# macOS (permanent): add to /etc/launchd.conf or use launchctl
# Linux (permanent): /etc/security/limits.conf
#   * soft nofile 65536
#   * hard nofile 65536
```

#### TCP Tuning (Linux)
```bash
# Increase local port range (for SSE client connections)
sysctl -w net.ipv4.ip_local_port_range="1024 65535"

# Reduce TIME_WAIT duration
sysctl -w net.ipv4.tcp_fin_timeout=15

# Enable TCP reuse
sysctl -w net.ipv4.tcp_tw_reuse=1

# Increase somaxconn (max listen backlog)
sysctl -w net.core.somaxconn=65535

# Increase max SYN backlog
sysctl -w net.ipv4.tcp_max_syn_backlog=65535
```

#### TCP Tuning (macOS)
```bash
# Increase somaxconn
sysctl -w kern.ipc.somaxconn=2048

# Increase max sockets
sysctl -w kern.ipc.maxsockets=65536

# Note: macOS has fewer tunables than Linux. The SSE_MAX_CONNECTIONS=2000
# cap in client-simulator.js exists partly because of macOS ephemeral port limits.
```

#### Network Buffer Sizes (Linux)
```bash
sysctl -w net.core.rmem_max=16777216
sysctl -w net.core.wmem_max=16777216
sysctl -w net.ipv4.tcp_rmem="4096 87380 16777216"
sysctl -w net.ipv4.tcp_wmem="4096 65536 16777216"
```

### 3.2 Node.js Flags

```bash
NODE_FLAGS="--max-old-space-size=4096 --expose-gc"
```

| Flag | Purpose |
|---|---|
| `--max-old-space-size=4096` | Prevent OOM at high connection counts. 4GB is sufficient for 10k connections. |
| `--expose-gc` | Enables `global.gc()` for explicit GC between test runs and GC metrics collection. |

**Do NOT use**: `--max-semi-space-size` (changes GC behavior, invalidates comparison), `--no-warnings` (hides useful diagnostics).

**Optional for deeper analysis**:
| Flag | Purpose |
|---|---|
| `--trace-gc` | Log every GC event with timing (redirect to file for post-analysis) |
| `--perf-basic-prof` | Generate perf map for Linux profiling |

### 3.3 Network Configuration

- **Run client and server on the same machine** (loopback) for the benchmark. This eliminates network variability. Document this clearly in results.
- **Force IPv4**: Already done in client-simulator.js (`family: 4`). Ensures consistent behavior and avoids dual-stack connection race conditions.
- **Disable Wi-Fi / external network interfaces** if possible. Background traffic on shared interfaces can introduce jitter even on loopback.
- **Same machine, separate processes**: Do NOT run client and server in the same Node.js process. They must compete for CPU and memory independently.

### 3.4 Eliminating Noise

| Source of Noise | Mitigation |
|---|---|
| Other user processes | Close browsers, IDEs, Slack. Or use a dedicated benchmark VM/container. |
| OS background tasks | macOS: disable Spotlight indexing (`sudo mdutil -a -i off`), Time Machine. Linux: stop cron jobs, systemd timers. |
| CPU frequency scaling | Linux: `cpupower frequency-set -g performance`. macOS: connect to power adapter (prevents throttling). |
| Thermal throttling | Monitor CPU temperature. Space out long test runs. |
| Swap usage | Ensure enough free RAM (at least 2x the expected RSS peak). Disable swap or set `swappiness=0` on Linux. |
| Node.js GC | Call `global.gc()` (with `--expose-gc`) before each test run starts. This doesn't eliminate GC during the test, but gives a clean starting point. |
| Disk I/O | Avoid logging to disk during the test itself. Buffer results in memory, write after test completes. |

**Preflight script should log**:
```json
{
  "hostname": "benchmark-host",
  "os": "Darwin 24.6.0",
  "arch": "arm64",
  "cpuModel": "Apple M2 Pro",
  "cpuCores": 12,
  "totalMemoryGB": 32,
  "freeMemoryGB": 24,
  "nodeVersion": "v20.11.0",
  "ulimitN": 65536,
  "loadAverage": [0.5, 0.4, 0.3],
  "timestamp": "2026-03-23T14:30:00.000Z"
}
```

---

## 4. New npm Scripts

Add the following to `package.json`:

```json
{
  "scripts": {
    "start": "concurrently -n ws,sse,client -c blue,green,magenta \"node server/websocket-server.js\" \"node server/sse-server.js\" \"node server/static-server.js\"",
    "start:ws": "node server/websocket-server.js",
    "start:sse": "node server/sse-server.js",
    "start:static": "node server/static-server.js",

    "test:ws": "node load-test/client-simulator.js websocket",
    "test:sse": "node load-test/client-simulator.js sse",

    "bench:quick": "bash load-test/run-benchmarks.sh quick",
    "bench:standard": "bash load-test/run-benchmarks.sh standard",
    "bench:comprehensive": "bash load-test/run-benchmarks.sh comprehensive",

    "bench:ws:latency": "node --max-old-space-size=4096 load-test/client-simulator.js websocket 1000 --duration=30 --mode=latency",
    "bench:sse:latency": "node --max-old-space-size=4096 load-test/client-simulator.js sse 1000 --duration=30 --mode=latency",
    "bench:ws:broadcast": "node --max-old-space-size=4096 load-test/client-simulator.js websocket 1000 --duration=30 --mode=broadcast",
    "bench:sse:broadcast": "node --max-old-space-size=4096 load-test/client-simulator.js sse 1000 --duration=30 --mode=broadcast",
    "bench:ws:scale": "node --max-old-space-size=4096 load-test/client-simulator.js websocket 10000 --mode=scalability",
    "bench:sse:scale": "node --max-old-space-size=4096 load-test/client-simulator.js sse 5000 --mode=scalability",

    "bench:preflight": "bash load-test/run-benchmarks.sh preflight",
    "bench:report": "node load-test/generate-report.js"
  }
}
```

### Script Descriptions

| Script | Purpose |
|---|---|
| `bench:quick` | Fast smoke test. 2 client tiers, 1 run each. ~5 min. |
| `bench:standard` | Default benchmark. 4 client tiers, 3 runs each. ~30 min. |
| `bench:comprehensive` | Full matrix. 5 client tiers, 5 runs each, all rates/sizes. ~3 hours. |
| `bench:ws:latency` | Single-protocol latency test with sensible defaults (ad-hoc use). |
| `bench:sse:latency` | Same for SSE. |
| `bench:ws:broadcast` | Broadcast-mode test (passive clients, measures fan-out). |
| `bench:sse:broadcast` | Same for SSE. |
| `bench:ws:scale` | WebSocket scalability staircase (100 to 10000). |
| `bench:sse:scale` | SSE scalability staircase (100 to 5000, capped by ephemeral ports). |
| `bench:preflight` | Run environment checks only, print warnings. No tests. |
| `bench:report` | Generate charts/summary from last results directory. |

---

## 5. Missing Metrics in `metrics.js`

### 5.1 Current State Analysis

The existing `metrics.js` tracks:
- Active connection count (increment/decrement)
- Total messages sent
- Messages per second (delta-based)
- Average latency (running total / samples -- **loses individual values**)
- Memory usage (heap + RSS only)
- CPU usage % (windowed average)
- Event loop lag (setInterval drift, 100ms resolution)
- Dropped connections (counter)

### 5.2 Missing Metrics -- Ranked by Importance

#### CRITICAL (Required for Fair Comparison)

**1. Percentile latencies (p50, p75, p90, p95, p99, p99.9)**

Current flaw: `metrics.js` only stores `totalLatency` and `latencySamples`, computing a running average. This discards the distribution entirely. An average of 5ms is meaningless if p99 is 500ms.

Design:
- Store latency samples in a fixed-size circular buffer (e.g., 100,000 entries). When full, evict oldest.
- Alternatively, use a streaming quantile estimator (t-digest or DDSketch algorithm) for memory-efficient percentile tracking without storing all samples.
- Expose via `/metrics` as: `latencyP50`, `latencyP75`, `latencyP90`, `latencyP95`, `latencyP99`, `latencyP999`.
- Also expose `latencyStddev` (standard deviation).

**2. Latency histogram buckets**

Expose a histogram with fixed bucket boundaries (e.g., 0-1ms, 1-2ms, 2-5ms, 5-10ms, 10-25ms, 25-50ms, 50-100ms, 100-250ms, 250-500ms, 500ms+). This is lighter than storing all samples and enables distribution visualization.

**3. Connection time tracking (server-side)**

Currently only tracked client-side in `globalStats.connectionTimes`. The server should also track:
- Time from TCP accept to first message sent (measures handshake overhead).
- For WebSocket: this includes the HTTP upgrade + WS handshake.
- For SSE: this includes the HTTP response header flush.
- This is the single most important metric for comparing protocol overhead.

**4. Bandwidth measurement (bytes sent/received)**

Neither server tracks total bytes transmitted. This matters because:
- SSE has per-message framing overhead (`data: ...\n\n` = 8 bytes per message).
- WebSocket has per-frame overhead (2-14 bytes depending on payload size + masking).
- At high message rates, framing overhead becomes significant.

Design: Increment a `bytesSent` counter in `recordMessageSent()` by passing the payload size. Expose `totalBytesSent` and `bytesPerSec` in `/metrics`.

#### IMPORTANT (Needed for Complete Analysis)

**5. Detailed memory breakdown**

Current: only `heapUsed` and `rss`.

Add:
- `heapTotal` (allocated heap size -- shows V8 heap growth strategy)
- `external` (memory for C++ objects bound to JS, e.g., Buffers -- important for WebSocket as `ws` uses native buffers)
- `arrayBuffers` (subset of external, significant for binary message handling)

**6. GC metrics**

With `--expose-gc`, use `perf_hooks` PerformanceObserver to track:
- GC pause count by type (Scavenge, Mark-Sweep, Incremental)
- Total GC pause time (ms)
- Max single GC pause (ms)

This reveals whether one protocol creates more GC pressure (e.g., SSE string concatenation vs WebSocket binary frames).

Design: Register a `PerformanceObserver` for `'gc'` entries. Accumulate counters.

**7. Event loop lag -- higher resolution**

Current: 100ms setInterval measuring drift gives 100ms resolution. This misses sub-100ms spikes.

Improvement: Use `perf_hooks.monitorEventLoopDelay()` (available since Node 11). It provides a histogram of event loop delays with microsecond precision, including built-in percentiles.

Design:
```
const h = monitorEventLoopDelay({ resolution: 20 });
h.enable();
// In getMetrics():
//   eventLoopLag.min, .max, .mean, .p50, .p99, .stddev
```

**8. Connection rate (connections per second)**

For scalability tests, it matters how fast clients can connect. Track:
- `connectionsPerSecond` (windowed, same approach as `messagesPerSecond`)
- `peakConnections` (high-water mark)
- `totalConnectionsEver` (cumulative, including disconnected)

#### NICE TO HAVE (For Advanced Analysis)

**9. Message delivery confirmation rate**

Percentage of sent messages that received a latency report back. Currently messages are broadcast to all clients but only some report back. Tracking this ratio reveals silent message loss.

**10. Per-connection memory cost**

Sample memory before and after connecting N clients (in controlled steps during scalability test). Compute: `(RSS_after - RSS_before) / N_clients`. This gives "cost per connection" in KB -- a key comparison metric.

**11. Backpressure metrics**

For SSE: track `res.write()` returning `false` (backpressure signal). Currently this triggers a dropped connection, but an intermediate "backpressured" state would be more informative.

For WebSocket: track `ws.bufferedAmount` -- if this grows, the server is sending faster than the client can receive.

**12. Timestamp precision**

Replace `Date.now()` (millisecond, subject to clock adjustment) with `process.hrtime.bigint()` (nanosecond, monotonic) for all latency measurements. This requires a shared epoch approach or differential timing, since `hrtime` is process-local.

Design: Send `Date.now()` in the message (for cross-process compatibility) but measure local processing time with `hrtime`. Document the inherent ~1ms precision limit of cross-process `Date.now()` measurement.

### 5.3 Summary of Changes Needed in `metrics.js`

```
Current API:
  addConnection()
  removeConnection()
  recordDroppedConnection()
  recordMessageSent()
  recordLatency(latency)
  getMetrics()
  getMemoryUsage()
  getCpuUsagePercent()
  resetMetrics()

Proposed API additions:
  recordMessageSent(bytesSent)     // Modified: accept byte count
  recordConnectionTime(timeMs)     // New: track handshake duration
  getLatencyPercentiles()          // New: returns {p50, p75, p90, p95, p99, p999, stddev}
  getLatencyHistogram()            // New: returns bucket counts
  getDetailedMemory()              // New: returns full process.memoryUsage()
  getGcMetrics()                   // New: returns {count, totalPauseMs, maxPauseMs, byType}
  getEventLoopDetailedLag()        // New: returns {min, max, mean, p50, p99} via perf_hooks
  getBandwidth()                   // New: returns {totalBytesSent, bytesPerSec}
  getConnectionRate()              // New: returns {connectionsPerSec, peakConnections, totalEver}

Modified getMetrics() response shape:
{
  connections: 1000,
  peakConnections: 1002,
  totalConnectionsEver: 1005,
  connectionsPerSec: 0,
  messagesSent: 30000,
  messagesPerSecond: 1000,
  totalBytesSent: 1920000,
  bytesPerSec: 64000,
  latency: {
    avg: 3,
    min: 1,
    max: 45,
    p50: 2,
    p75: 3,
    p90: 5,
    p95: 8,
    p99: 22,
    p999: 40,
    stddev: 4.2,
    samples: 30000,
    histogram: { "0-1": 5000, "1-2": 10000, "2-5": 10000, ... }
  },
  connectionTime: {
    avg: 12,
    p50: 10,
    p95: 25,
    p99: 45,
    max: 120
  },
  memoryUsage: {
    heapUsed: 85,
    heapTotal: 120,
    rss: 150,
    external: 12,
    arrayBuffers: 8
  },
  cpuUsagePercent: 35,
  eventLoopLag: {
    current: 2,
    max: 15,
    mean: 3,
    p50: 2,
    p99: 12
  },
  gc: {
    count: 45,
    totalPauseMs: 120,
    maxPauseMs: 15,
    byType: { scavenge: 40, markSweep: 5 }
  },
  droppedConnections: 2,
  backpressureEvents: 0
}
```

### 5.4 Fairness Considerations

Several structural differences between SSE and WebSocket affect fairness:

1. **SSE uses Express; WebSocket uses raw `http`**. Express adds overhead (middleware chain, body parsing). For a fair comparison, either both should use raw `http`, or this overhead should be documented as "SSE with Express" vs "WebSocket raw." The current comparison has this bias.

2. **SSE latency reporting uses a separate HTTP POST** (`/latency`), which creates additional connections and load. WebSocket reports latency over the same connection. This inflates SSE's apparent resource usage. Mitigation: exclude latency-reporting overhead from measurements, or skip latency reporting in broadcast mode (already done).

3. **SSE connection cap at 2000** (`SSE_MAX_CONNECTIONS`) is a client-side artificial limit. While justified (ephemeral port exhaustion), it means SSE scalability tests never reach the same connection counts as WebSocket. This should be clearly documented in results.

4. **Message framing cost is invisible**. WebSocket binary framing is handled at the C++ layer in the `ws` library. SSE's `data: ...\n\n` framing is in JavaScript. Bandwidth metrics (proposed above) would surface this difference.

---

## Appendix: Recommended Test Scenarios

For the `standard` profile, the test matrix should cover these scenarios in priority order:

| # | Scenario | Protocol | Clients | Rate | Msg Size | Measures |
|---|---|---|---|---|---|---|
| 1 | Baseline latency | both | 100 | 1/s | 64B | Raw protocol overhead |
| 2 | Moderate load | both | 500 | 10/s | 64B | Typical production-like |
| 3 | High connection count | both | 2000 | 1/s | 64B | Connection scalability |
| 4 | High message rate | both | 100 | 50/s | 64B | Throughput ceiling |
| 5 | Large messages | both | 100 | 1/s | 4096B | Serialization + bandwidth |
| 6 | Combined stress | both | 1000 | 10/s | 1024B | Realistic worst case |
| 7 | Scalability staircase | both | 100-5000 | 1/s | 64B | At what point does it break? |
