#!/usr/bin/env node
/**
 * Benchmark Comparison Tool
 *
 * Reads all JSON result files from a results directory and produces
 * a side-by-side comparison of WebSocket vs SSE performance.
 *
 * Usage:
 *   node load-test/compare-results.js results/20260323_120000/
 */

const fs = require('fs');
const path = require('path');

// ─── Terminal colors ────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseOutput(output) {
  if (!output || typeof output !== 'string') return {};

  const parsed = {};
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^(.+?):\s+(.+)$/);
    if (!match) continue;

    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();

    if (key.includes('average latency') || key.includes('avg latency')) {
      parsed.avgLatency = parseFloat(value);
    } else if (key.includes('min latency')) {
      parsed.minLatency = parseFloat(value);
    } else if (key.includes('max latency')) {
      parsed.maxLatency = parseFloat(value);
    } else if (key.includes('connections') && !key.includes('dropped')) {
      parsed.connections = parseInt(value, 10);
    } else if (key.includes('messages received')) {
      parsed.messagesReceived = parseInt(value, 10);
    } else if (key.includes('message rate')) {
      parsed.messageRate = parseFloat(value);
    } else if (key.includes('message size')) {
      parsed.messageSize = parseInt(value, 10);
    } else if (key.includes('dropped')) {
      parsed.droppedConnections = parseInt(value, 10);
    } else if (key.includes('memory usage') || key.includes('memory')) {
      const rssMatch = value.match(/rss\s+([\d.]+)MB/i);
      const heapMatch = value.match(/heap\s+([\d.]+)MB/i);
      if (rssMatch) parsed.memoryRssMB = parseFloat(rssMatch[1]);
      if (heapMatch) parsed.memoryHeapMB = parseFloat(heapMatch[1]);
    } else if (key.includes('cpu usage') || key.includes('cpu')) {
      parsed.cpuPercent = parseFloat(value);
    } else if (key.includes('event loop lag')) {
      parsed.eventLoopLagMs = parseFloat(value);
    } else if (key.includes('avg connection time') || key.includes('connection time')) {
      parsed.avgConnectionTime = parseFloat(value);
    } else if (key.includes('error')) {
      parsed.errors = parseInt(value, 10);
    }
  }

  return parsed;
}

function extractMetrics(result) {
  const sm = result.serverMetrics || {};
  const outputParsed = parseOutput(result.output);

  // Latency from server metrics
  const latency = sm.latency || {};
  const p50 = latency.p50 ?? latency.median ?? outputParsed.avgLatency ?? null;
  const p95 = latency.p95 ?? null;
  const p99 = latency.p99 ?? null;
  const avg = latency.avg ?? latency.mean ?? outputParsed.avgLatency ?? null;

  // Memory
  const mem = sm.memoryUsage || {};
  let rssMB = null;
  if (typeof mem === 'object' && mem.rssMB !== undefined) {
    rssMB = mem.rssMB;
  } else if (outputParsed.memoryRssMB) {
    rssMB = outputParsed.memoryRssMB;
  }

  // CPU
  const cpuPercent = sm.cpuUsagePercent ?? outputParsed.cpuPercent ?? null;

  // Throughput
  const messagesReceived = sm.totalMessages ?? outputParsed.messagesReceived ?? 0;
  const duration = result.duration || 30;
  const msgPerSec = sm.messageRate ?? (messagesReceived > 0 ? Math.round(messagesReceived / duration) : null);

  // Connection time
  const avgConnectionTime = outputParsed.avgConnectionTime ?? null;

  // Event loop lag
  const eventLoopLagMs = sm.eventLoopLagMs ?? outputParsed.eventLoopLagMs ?? null;

  // Connections
  const connections = sm.connections ?? outputParsed.connections ?? result.clients ?? 0;

  return {
    p50,
    p95,
    p99,
    avg,
    rssMB,
    cpuPercent,
    msgPerSec,
    avgConnectionTime,
    eventLoopLagMs,
    connections,
    errors: outputParsed.errors ?? 0,
    droppedConnections: sm.droppedConnections ?? outputParsed.droppedConnections ?? 0,
  };
}

/**
 * Group test results by base test name (without protocol suffix).
 * Returns Map<baseName, { ws: result[], sse: result[] }>
 */
function groupResults(results) {
  const groups = new Map();

  for (const result of results) {
    const testName = result.testName || 'unknown';
    const protocol = (result.protocol || '').toLowerCase();

    // Derive base name by removing -websocket or -sse suffix from filename
    // The testName already doesn't include protocol, it's stored separately
    const baseName = testName;

    if (!groups.has(baseName)) {
      groups.set(baseName, { ws: [], sse: [] });
    }

    const key = protocol === 'websocket' ? 'ws' : 'sse';
    groups.get(baseName)[key].push(result);
  }

  return groups;
}

// ─── Table rendering ────────────────────────────────────────────────────────

function formatValue(val, unit) {
  if (val === null || val === undefined || isNaN(val)) return '-';
  if (unit === 'ms') return `${Math.round(val * 100) / 100}ms`;
  if (unit === 'MB') return `${Math.round(val * 10) / 10}MB`;
  if (unit === '%') return `${Math.round(val * 10) / 10}%`;
  if (unit === '/s') return `${Math.round(val)}/s`;
  return `${val}`;
}

function pickWinner(wsVal, sseVal, lowerIsBetter) {
  if (wsVal === null && sseVal === null) return 'TIE';
  if (wsVal === null) return 'SSE';
  if (sseVal === null) return 'WS';
  if (isNaN(wsVal) && isNaN(sseVal)) return 'TIE';
  if (isNaN(wsVal)) return 'SSE';
  if (isNaN(sseVal)) return 'WS';

  const diff = Math.abs(wsVal - sseVal);
  const avg = (Math.abs(wsVal) + Math.abs(sseVal)) / 2;
  // Treat as tie if within 5% of each other
  if (avg > 0 && diff / avg < 0.05) return 'TIE';

  if (lowerIsBetter) {
    return wsVal < sseVal ? 'WS' : 'SSE';
  }
  return wsVal > sseVal ? 'WS' : 'SSE';
}

function colorWinner(winner) {
  if (winner === 'WS') return `${c.blue}WS  ${c.green}\u2713${c.reset}`;
  if (winner === 'SSE') return `${c.cyan}SSE ${c.green}\u2713${c.reset}`;
  return `${c.dim}TIE${c.reset}  `;
}

function printComparisonTable(title, wsMetrics, sseMetrics) {
  const metrics = [
    { label: 'p50 latency', wsVal: wsMetrics.p50, sseVal: sseMetrics.p50, unit: 'ms', lower: true },
    { label: 'p95 latency', wsVal: wsMetrics.p95, sseVal: sseMetrics.p95, unit: 'ms', lower: true },
    { label: 'p99 latency', wsVal: wsMetrics.p99, sseVal: sseMetrics.p99, unit: 'ms', lower: true },
    { label: 'Avg latency', wsVal: wsMetrics.avg, sseVal: sseMetrics.avg, unit: 'ms', lower: true },
    { label: 'msg/sec', wsVal: wsMetrics.msgPerSec, sseVal: sseMetrics.msgPerSec, unit: '/s', lower: false },
    { label: 'Memory (RSS)', wsVal: wsMetrics.rssMB, sseVal: sseMetrics.rssMB, unit: 'MB', lower: true },
    { label: 'CPU', wsVal: wsMetrics.cpuPercent, sseVal: sseMetrics.cpuPercent, unit: '%', lower: true },
    { label: 'Conn time', wsVal: wsMetrics.avgConnectionTime, sseVal: sseMetrics.avgConnectionTime, unit: 'ms', lower: true },
    { label: 'Event loop', wsVal: wsMetrics.eventLoopLagMs, sseVal: sseMetrics.eventLoopLagMs, unit: 'ms', lower: true },
    { label: 'Connections', wsVal: wsMetrics.connections, sseVal: sseMetrics.connections, unit: '', lower: false },
  ];

  // Filter out rows where both values are missing
  const visibleMetrics = metrics.filter(
    (m) => m.wsVal !== null || m.sseVal !== null
  );

  if (visibleMetrics.length === 0) {
    console.log(`${c.dim}  (no comparable metrics available)${c.reset}\n`);
    return { wsWins: 0, sseWins: 0, ties: 0, details: [] };
  }

  const W = 62;

  console.log('\u2554' + '\u2550'.repeat(W) + '\u2557');
  console.log('\u2551 ' + `${c.bold}${title}${c.reset}`.padEnd(W + 9) + '\u2551');
  console.log('\u2560' + '\u2550'.repeat(W) + '\u2563');
  console.log(
    '\u2551 ' +
      'Metric'.padEnd(16) +
      '\u2502 ' +
      'WebSocket'.padEnd(14) +
      '\u2502 ' +
      'SSE'.padEnd(14) +
      '\u2502 ' +
      'Winner'.padEnd(8) +
      '\u2551'
  );
  console.log(
    '\u2551\u2500' +
      '\u2500'.repeat(16) +
      '\u253c\u2500' +
      '\u2500'.repeat(14) +
      '\u253c\u2500' +
      '\u2500'.repeat(14) +
      '\u253c\u2500' +
      '\u2500'.repeat(8) +
      '\u2551'
  );

  let wsWins = 0;
  let sseWins = 0;
  let ties = 0;
  const details = [];

  for (const m of visibleMetrics) {
    const winner = pickWinner(m.wsVal, m.sseVal, m.lower);
    if (winner === 'WS') wsWins++;
    else if (winner === 'SSE') sseWins++;
    else ties++;

    details.push({
      metric: m.label,
      ws: m.wsVal,
      sse: m.sseVal,
      winner,
    });

    const wsStr = formatValue(m.wsVal, m.unit).padEnd(14);
    const sseStr = formatValue(m.sseVal, m.unit).padEnd(14);
    const winStr = colorWinner(winner);

    console.log(
      '\u2551 ' +
        m.label.padEnd(16) +
        '\u2502 ' +
        wsStr +
        '\u2502 ' +
        sseStr +
        '\u2502 ' +
        winStr +
        ' \u2551'
    );
  }

  console.log('\u255a' + '\u2550'.repeat(W) + '\u255d');
  console.log('');

  return { wsWins, sseWins, ties, details };
}

/**
 * Average metrics across multiple runs of the same test.
 */
function averageMetrics(results) {
  if (results.length === 0) return null;
  if (results.length === 1) return extractMetrics(results[0]);

  const allMetrics = results.map(extractMetrics);
  const keys = Object.keys(allMetrics[0]);
  const averaged = {};

  for (const key of keys) {
    const values = allMetrics
      .map((m) => m[key])
      .filter((v) => v !== null && v !== undefined && !isNaN(v));

    if (values.length === 0) {
      averaged[key] = null;
    } else {
      averaged[key] = values.reduce((a, b) => a + b, 0) / values.length;
    }
  }

  return averaged;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const resultsDir = process.argv[2];

  if (!resultsDir) {
    console.error('Usage: node compare-results.js <results-directory>');
    console.error('Example: node compare-results.js results/20260323_120000/');
    process.exit(1);
  }

  const resolvedDir = path.resolve(resultsDir);

  if (!fs.existsSync(resolvedDir)) {
    console.error(`Error: Directory not found: ${resolvedDir}`);
    process.exit(1);
  }

  // Read all JSON files
  const files = fs.readdirSync(resolvedDir).filter((f) => f.endsWith('.json') && f !== 'comparison.json');

  if (files.length === 0) {
    console.error(`Error: No JSON result files found in ${resolvedDir}`);
    process.exit(1);
  }

  console.log(`\n${c.bold}${c.cyan}Loading ${files.length} result files from ${resolvedDir}${c.reset}\n`);

  const results = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(resolvedDir, file), 'utf8');
      const data = JSON.parse(content);
      results.push(data);
    } catch (err) {
      console.error(`${c.yellow}Warning: Could not parse ${file}: ${err.message}${c.reset}`);
    }
  }

  if (results.length === 0) {
    console.error('Error: No valid result files could be parsed.');
    process.exit(1);
  }

  // Group results by test name
  const groups = groupResults(results);

  console.log(
    `${c.bold}Found ${groups.size} test group(s) across ${results.length} result files${c.reset}\n`
  );

  let totalWsWins = 0;
  let totalSseWins = 0;
  let totalTies = 0;
  const comparisonData = {};

  // Sort groups by name for consistent output
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [baseName, group] of sortedGroups) {
    if (group.ws.length === 0 && group.sse.length === 0) continue;

    const wsMetrics = group.ws.length > 0 ? averageMetrics(group.ws) : extractMetrics({});
    const sseMetrics = group.sse.length > 0 ? averageMetrics(group.sse) : extractMetrics({});

    if (!wsMetrics && !sseMetrics) continue;

    const wsM = wsMetrics || {
      p50: null, p95: null, p99: null, avg: null,
      rssMB: null, cpuPercent: null, msgPerSec: null,
      avgConnectionTime: null, eventLoopLagMs: null,
      connections: null, errors: 0, droppedConnections: 0,
    };

    const sseM = sseMetrics || {
      p50: null, p95: null, p99: null, avg: null,
      rssMB: null, cpuPercent: null, msgPerSec: null,
      avgConnectionTime: null, eventLoopLagMs: null,
      connections: null, errors: 0, droppedConnections: 0,
    };

    // Build title from test name
    const clients = group.ws[0]?.clients || group.sse[0]?.clients || '?';
    const title = `${baseName} - ${clients} clients`;

    const { wsWins, sseWins, ties, details } = printComparisonTable(
      title,
      wsM,
      sseM
    );

    totalWsWins += wsWins;
    totalSseWins += sseWins;
    totalTies += ties;

    comparisonData[baseName] = {
      clients,
      wsMetrics: wsM,
      sseMetrics: sseM,
      wsWins,
      sseWins,
      ties,
      details,
    };
  }

  // ── Overall Summary ─────────────────────────────────────────────────────

  console.log(`${c.bold}${'='.repeat(62)}${c.reset}`);
  console.log(`${c.bold}  OVERALL SUMMARY${c.reset}`);
  console.log(`${c.bold}${'='.repeat(62)}${c.reset}`);
  console.log('');

  const wsColor = totalWsWins >= totalSseWins ? c.green : c.reset;
  const sseColor = totalSseWins >= totalWsWins ? c.green : c.reset;

  console.log(`  ${c.blue}WebSocket${c.reset} wins: ${wsColor}${c.bold}${totalWsWins}${c.reset} metrics`);
  console.log(`  ${c.cyan}SSE${c.reset}       wins: ${sseColor}${c.bold}${totalSseWins}${c.reset} metrics`);
  console.log(`  ${c.dim}Ties:           ${totalTies} metrics${c.reset}`);
  console.log('');

  if (totalWsWins > totalSseWins) {
    console.log(`  ${c.bold}${c.blue}>> WebSocket wins overall (${totalWsWins} vs ${totalSseWins}) <<${c.reset}`);
  } else if (totalSseWins > totalWsWins) {
    console.log(`  ${c.bold}${c.cyan}>> SSE wins overall (${totalSseWins} vs ${totalWsWins}) <<${c.reset}`);
  } else {
    console.log(`  ${c.bold}${c.yellow}>> It's a tie! (${totalWsWins} vs ${totalSseWins}) <<${c.reset}`);
  }

  console.log('');
  console.log(`${c.bold}${'='.repeat(62)}${c.reset}\n`);

  // ── Save comparison JSON ────────────────────────────────────────────────

  const comparisonFile = path.join(resolvedDir, 'comparison.json');
  const comparisonOutput = {
    generatedAt: new Date().toISOString(),
    resultsDirectory: resolvedDir,
    totalFiles: files.length,
    summary: {
      wsWins: totalWsWins,
      sseWins: totalSseWins,
      ties: totalTies,
      overallWinner:
        totalWsWins > totalSseWins
          ? 'WebSocket'
          : totalSseWins > totalWsWins
            ? 'SSE'
            : 'Tie',
    },
    tests: comparisonData,
  };

  try {
    fs.writeFileSync(comparisonFile, JSON.stringify(comparisonOutput, null, 2), 'utf8');
    console.log(`${c.green}Comparison saved to ${comparisonFile}${c.reset}\n`);
  } catch (err) {
    console.error(`${c.red}Error saving comparison: ${err.message}${c.reset}`);
  }
}

main();
