#!/usr/bin/env node
/**
 * Generate Excel report with benchmark results and charts.
 * Usage: node load-test/generate-excel.js
 */

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const RESULTS_DIR = path.join(__dirname, '..', 'results');
const OUTPUT_FILE = path.join(RESULTS_DIR, 'benchmark-report.xlsx');

// Color palette
const WS_COLOR = '4472C4';   // Blue
const SSE_COLOR = 'ED7D31';  // Orange
const HEADER_BG = '2F5496';
const HEADER_FG = 'FFFFFF';
const WINNER_BG = 'C6EFCE';
const LIGHTER_ROW = 'F2F7FB';

function headerStyle() {
  return {
    font: { bold: true, color: { argb: HEADER_FG }, size: 11 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: {
      bottom: { style: 'thin', color: { argb: '000000' } },
    },
  };
}

function numFmt(decimals = 0) {
  return decimals > 0 ? `#,##0.${'0'.repeat(decimals)}` : '#,##0';
}

function addComparisonTable(ws, title, headers, wsData, sseData, lowerIsBetter) {
  // Title
  const titleRow = ws.addRow([title]);
  titleRow.font = { bold: true, size: 14 };
  ws.mergeCells(titleRow.number, 1, titleRow.number, 4);
  ws.addRow([]);

  // Headers
  const hRow = ws.addRow(headers);
  hRow.eachCell((cell) => Object.assign(cell, headerStyle()));

  // Data rows
  for (let i = 0; i < wsData.length; i++) {
    const label = wsData[i][0];
    const wsVal = wsData[i][1];
    const sseVal = sseData[i][1];

    let winner = '';
    if (typeof wsVal === 'number' && typeof sseVal === 'number' && wsVal !== 0 && sseVal !== 0) {
      if (lowerIsBetter[i]) {
        winner = wsVal < sseVal ? 'WebSocket' : wsVal > sseVal ? 'SSE' : 'Tie';
      } else {
        winner = wsVal > sseVal ? 'WebSocket' : wsVal < sseVal ? 'SSE' : 'Tie';
      }
    }

    const row = ws.addRow([label, wsVal, sseVal, winner]);
    if (i % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHTER_ROW } };
      });
    }
    if (winner) {
      row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WINNER_BG } };
      row.getCell(4).font = { bold: true };
    }
  }
  ws.addRow([]);
}

function addBarChart(ws, title, startRow, dataRows, categoryCol, wsCol, sseCol) {
  const chart = ws.addChart('bar', {
    title: { text: title },
    legend: { position: 'bottom' },
  });

  const categories = [];
  const wsValues = [];
  const sseValues = [];

  for (let i = 0; i < dataRows; i++) {
    const row = ws.getRow(startRow + i);
    categories.push(row.getCell(categoryCol).value || '');
    wsValues.push(row.getCell(wsCol).value || 0);
    sseValues.push(row.getCell(sseCol).value || 0);
  }

  // ExcelJS chart API is limited - we'll use data references
  const sheetName = ws.name;
  chart.addSeries({
    name: 'WebSocket',
    categories: { ref: `'${sheetName}'!$A$${startRow}:$A$${startRow + dataRows - 1}` },
    values: { ref: `'${sheetName}'!$B$${startRow}:$B$${startRow + dataRows - 1}` },
    color: WS_COLOR,
  });

  chart.addSeries({
    name: 'SSE',
    categories: { ref: `'${sheetName}'!$A$${startRow}:$A$${startRow + dataRows - 1}` },
    values: { ref: `'${sheetName}'!$C$${startRow}:$C$${startRow + dataRows - 1}` },
    color: SSE_COLOR,
  });

  return chart;
}

async function main() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SSE vs WebSocket Benchmark';
  wb.created = new Date();

  // ========== SHEET 1: Summary ==========
  const summary = wb.addWorksheet('Summary', { properties: { tabColor: { argb: '2F5496' } } });
  summary.columns = [
    { header: 'Metric', key: 'metric', width: 30 },
    { header: 'WebSocket', key: 'ws', width: 18 },
    { header: 'SSE', key: 'sse', width: 18 },
    { header: 'Winner', key: 'winner', width: 15 },
  ];
  const sHdr = summary.getRow(1);
  sHdr.eachCell((cell) => Object.assign(cell, headerStyle()));

  // ========== SHEET 2: Echo Round-Trip ==========
  const echoSheet = wb.addWorksheet('Echo Round-Trip', { properties: { tabColor: { argb: WS_COLOR } } });
  echoSheet.columns = [
    { header: 'Metric', key: 'metric', width: 25 },
    { header: 'WebSocket', key: 'ws', width: 18 },
    { header: 'SSE', key: 'sse', width: 18 },
    { header: 'Winner', key: 'winner', width: 15 },
  ];

  let echoWs, echoSse;
  try { echoWs = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, 'echo-ws.json'))); } catch { echoWs = null; }
  try { echoSse = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, 'echo-sse.json'))); } catch { echoSse = null; }

  if (echoWs && echoSse) {
    const wsL = echoWs.latency || {};
    const sseL = echoSse.latency || {};

    const echoData = [
      ['RTT p50 (ms)', wsL.p50 || 0, sseL.p50 || 0],
      ['RTT p95 (ms)', wsL.p95 || 0, sseL.p95 || 0],
      ['RTT p99 (ms)', wsL.p99 || 0, sseL.p99 || 0],
      ['RTT min (ms)', wsL.min || 0, sseL.min || 0],
      ['RTT max (ms)', wsL.max || 0, sseL.max || 0],
      ['RTT avg (ms)', wsL.avg || 0, sseL.avg || 0],
      ['RTT stddev (ms)', wsL.stddev || 0, sseL.stddev || 0],
      ['Total echoes', echoWs.throughput?.messagesReceived || 0, echoSse.throughput?.messagesReceived || 0],
    ];
    const lowerBetter = [true, true, true, true, true, true, true, false];

    addComparisonTable(
      echoSheet,
      'Echo Round-Trip Latency (100 clients, 10 echo/sec, 15s)',
      ['Metric', 'WebSocket', 'SSE', 'Winner'],
      echoData.map(r => [r[0], r[1]]),
      echoData.map(r => [r[0], r[2]]),
      lowerBetter
    );

    // Chart data for echo
    const chartDataStart = echoSheet.rowCount + 2;
    const chartLabels = ['p50', 'p95', 'p99', 'avg'];
    const chartWsVals = [wsL.p50, wsL.p95, wsL.p99, wsL.avg];
    const chartSseVals = [sseL.p50, sseL.p95, sseL.p99, sseL.avg];

    echoSheet.addRow([]);
    const cdTitle = echoSheet.addRow(['Chart Data', 'WebSocket (ms)', 'SSE (ms)']);
    cdTitle.eachCell((c) => Object.assign(c, headerStyle()));
    const cdStart = echoSheet.rowCount + 1;
    for (let i = 0; i < chartLabels.length; i++) {
      echoSheet.addRow([chartLabels[i], chartWsVals[i], chartSseVals[i]]);
    }

    // Summary row for this test
    summary.addRow({
      metric: 'Echo RTT p50 (ms)',
      ws: wsL.p50 || 0,
      sse: sseL.p50 || 0,
      winner: (wsL.p50 || 0) <= (sseL.p50 || 0) ? 'WebSocket' : 'SSE',
    });
    summary.addRow({
      metric: 'Echo RTT p99 (ms)',
      ws: wsL.p99 || 0,
      sse: sseL.p99 || 0,
      winner: (wsL.p99 || 0) <= (sseL.p99 || 0) ? 'WebSocket' : 'SSE',
    });
  }

  // ========== SHEET 3: Throughput ==========
  const tpSheet = wb.addWorksheet('Throughput', { properties: { tabColor: { argb: WS_COLOR } } });
  tpSheet.columns = [
    { header: 'Rate (msg/sec)', key: 'rate', width: 18 },
    { header: 'WS Received', key: 'wsRecv', width: 15 },
    { header: 'WS Delivery %', key: 'wsDel', width: 15 },
    { header: 'WS Avg Latency', key: 'wsLat', width: 16 },
    { header: 'SSE Received', key: 'sseRecv', width: 15 },
    { header: 'SSE Delivery %', key: 'sseDel', width: 15 },
    { header: 'SSE Avg Latency', key: 'sseLat', width: 16 },
    { header: 'Winner', key: 'winner', width: 12 },
  ];
  const tpHdr = tpSheet.getRow(1);
  tpHdr.eachCell((cell) => Object.assign(cell, headerStyle()));

  // Parse throughput data from text files
  function parseThroughputText(filePath) {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const rows = [];
      const lines = text.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([\d.]+)%?\s*\|\s*([\d.]+)ms\s*\|\s*([\d.]+)ms\s*\|\s*(\d+)/);
        if (match) {
          rows.push({
            rate: parseInt(match[1]),
            received: parseInt(match[2]),
            delivery: parseFloat(match[3]),
            avgLatency: parseFloat(match[4]),
            p99Latency: parseFloat(match[5]),
            dropped: parseInt(match[6]),
          });
        }
      }
      return rows;
    } catch { return []; }
  }

  const tpWs = parseThroughputText(path.join(RESULTS_DIR, 'throughput-ws.txt'));
  const tpSse = parseThroughputText(path.join(RESULTS_DIR, 'throughput-sse.txt'));

  // SSE throughput crashed - use partial data
  const rates = [10, 50, 100, 200, 500, 1000];

  for (const rate of rates) {
    const ws = tpWs.find(r => r.rate === rate);
    const sse = tpSse.find(r => r.rate === rate);
    const wsRecv = ws?.received ?? 0;
    const sseRecv = sse?.received ?? 0;
    const wsDel = ws?.delivery ?? 0;
    const sseDel = sse?.delivery ?? 0;
    const wsLat = ws?.avgLatency ?? 0;
    const sseLat = sse?.avgLatency ?? 0;

    let winner = '';
    if (wsDel > 0 && sseDel > 0) {
      winner = wsDel >= sseDel ? 'WebSocket' : 'SSE';
    } else if (wsDel > 0) {
      winner = 'WebSocket';
    } else if (sseDel > 0) {
      winner = 'SSE';
    }

    const row = tpSheet.addRow({
      rate, wsRecv, wsDel, wsLat: wsLat + 'ms',
      sseRecv: sseRecv, sseDel: sseDel, sseLat: sseLat > 0 ? sseLat + 'ms' : 'CRASH',
      winner,
    });
    if (tpSheet.rowCount % 2 === 0) {
      row.eachCell((c) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHTER_ROW } };
      });
    }
  }

  // Chart data
  tpSheet.addRow([]);
  const tpChartTitle = tpSheet.addRow(['Rate', 'WS Delivery %', 'SSE Delivery %']);
  tpChartTitle.eachCell((c) => Object.assign(c, headerStyle()));
  for (const rate of rates) {
    const ws = tpWs.find(r => r.rate === rate);
    const sse = tpSse.find(r => r.rate === rate);
    tpSheet.addRow([rate, ws?.delivery ?? 0, sse?.delivery ?? 0]);
  }

  // Summary
  summary.addRow({
    metric: 'Throughput @1000/s delivery %',
    ws: tpWs.find(r => r.rate === 1000)?.delivery ?? 0,
    sse: tpSse.find(r => r.rate === 1000)?.delivery ?? 0,
    winner: 'WebSocket',
  });

  // ========== SHEET 4: Fan-Out Broadcast ==========
  const foSheet = wb.addWorksheet('Fan-Out Broadcast', { properties: { tabColor: { argb: SSE_COLOR } } });
  foSheet.columns = [
    { header: 'Metric', key: 'metric', width: 30 },
    { header: 'WebSocket', key: 'ws', width: 18 },
    { header: 'SSE', key: 'sse', width: 18 },
    { header: 'Winner', key: 'winner', width: 15 },
  ];
  const foHdr = foSheet.getRow(1);
  foHdr.eachCell((cell) => Object.assign(cell, headerStyle()));

  let foWs, foSse;
  try { foWs = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, 'fanout-ws.json'))); } catch { foWs = null; }
  try { foSse = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, 'fanout-sse.json'))); } catch { foSse = null; }

  if (foWs && foSse) {
    const wsL = foWs.latency || {};
    const sseL = foSse.latency || {};
    const wsR = foWs.resources || {};
    const sseR = foSse.resources || {};
    const wsM = wsR.memoryUsage || {};
    const sseM = sseR.memoryUsage || {};

    const data = [
      ['Connections', foWs.connections?.established || 0, foSse.connections?.established || 0, false],
      ['Messages received', foWs.throughput?.messagesReceived || 0, foSse.throughput?.messagesReceived || 0, false],
      ['Msg/sec', foWs.throughput?.msgPerSec || 0, foSse.throughput?.msgPerSec || 0, false],
      ['Latency p50 (ms)', wsL.p50 || 0, sseL.p50 || 0, true],
      ['Latency p95 (ms)', wsL.p95 || 0, sseL.p95 || 0, true],
      ['Latency p99 (ms)', wsL.p99 || 0, sseL.p99 || 0, true],
      ['Latency avg (ms)', wsL.avg || 0, sseL.avg || 0, true],
      ['Memory RSS (MB)', wsM.rssMB || 0, sseM.rssMB || 0, true],
      ['Memory Heap (MB)', wsM.heapMB || 0, sseM.heapMB || 0, true],
      ['CPU %', wsR.cpuUsagePercent || 0, sseR.cpuUsagePercent || 0, true],
      ['Dropped connections', foWs.connections?.dropped || 0, foSse.connections?.dropped || 0, true],
      ['Conn time avg (ms)', foWs.connections?.avgConnectTimeMs || 0, foSse.connections?.avgConnectTimeMs || 0, true],
    ];

    for (const [label, wsVal, sseVal, lowerBetter] of data) {
      let winner = '';
      if (typeof wsVal === 'number' && typeof sseVal === 'number' && (wsVal !== 0 || sseVal !== 0)) {
        if (lowerBetter) {
          winner = wsVal <= sseVal ? 'WebSocket' : 'SSE';
        } else {
          winner = wsVal >= sseVal ? 'WebSocket' : 'SSE';
        }
      }
      const row = foSheet.addRow({ metric: label, ws: wsVal, sse: sseVal, winner });
      if (foSheet.rowCount % 2 === 0) {
        row.eachCell((c) => {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHTER_ROW } };
        });
      }
      if (winner) {
        row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WINNER_BG } };
        row.getCell(4).font = { bold: true };
      }
    }

    // Chart data
    foSheet.addRow([]);
    const foChartTitle = foSheet.addRow(['Metric', 'WebSocket', 'SSE']);
    foChartTitle.eachCell((c) => Object.assign(c, headerStyle()));
    foSheet.addRow(['p50 Latency (ms)', wsL.p50, sseL.p50]);
    foSheet.addRow(['p95 Latency (ms)', wsL.p95, sseL.p95]);
    foSheet.addRow(['p99 Latency (ms)', wsL.p99, sseL.p99]);
    foSheet.addRow(['Memory RSS (MB)', wsM.rssMB, sseM.rssMB]);
    foSheet.addRow(['CPU %', wsR.cpuUsagePercent, sseR.cpuUsagePercent]);

    summary.addRow({
      metric: 'Fan-Out 1000 p50 latency (ms)',
      ws: wsL.p50 || 0,
      sse: sseL.p50 || 0,
      winner: (wsL.p50 || 0) <= (sseL.p50 || 0) ? 'WebSocket' : 'SSE',
    });
    summary.addRow({
      metric: 'Fan-Out 1000 Memory RSS (MB)',
      ws: wsM.rssMB || 0,
      sse: sseM.rssMB || 0,
      winner: (wsM.rssMB || 0) <= (sseM.rssMB || 0) ? 'WebSocket' : 'SSE',
    });
    summary.addRow({
      metric: 'Fan-Out 1000 CPU %',
      ws: wsR.cpuUsagePercent || 0,
      sse: sseR.cpuUsagePercent || 0,
      winner: (wsR.cpuUsagePercent || 0) <= (sseR.cpuUsagePercent || 0) ? 'WebSocket' : 'SSE',
    });
  }

  // ========== SHEET 5: Reconnection ==========
  const rcSheet = wb.addWorksheet('Reconnection', { properties: { tabColor: { argb: SSE_COLOR } } });
  rcSheet.columns = [
    { header: 'Metric', key: 'metric', width: 30 },
    { header: 'WebSocket', key: 'ws', width: 18 },
    { header: 'SSE', key: 'sse', width: 18 },
    { header: 'Winner', key: 'winner', width: 15 },
  ];
  const rcHdr = rcSheet.getRow(1);
  rcHdr.eachCell((cell) => Object.assign(cell, headerStyle()));

  let rcWs, rcSse;
  try { rcWs = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, 'reconnect-ws.json'))); } catch { rcWs = null; }
  try { rcSse = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, 'reconnect-sse.json'))); } catch { rcSse = null; }

  if (rcWs && rcSse) {
    const wsD = rcWs.reconnect || rcWs;
    const sseD = rcSse.reconnect || rcSse;

    // Try to extract reconnect data from various possible JSON structures
    const getVal = (obj, ...keys) => {
      for (const k of keys) {
        if (obj[k] !== undefined) return obj[k];
      }
      return 0;
    };

    // Parse from text files for more reliable data
    function parseReconnectText(filePath) {
      try {
        const text = fs.readFileSync(filePath, 'utf8');
        const data = {};
        const match = (pattern) => {
          const m = text.match(pattern);
          return m ? parseFloat(m[1]) : 0;
        };
        data.reconnected = match(/Reconnected:\s+(\d+)/);
        data.failed = match(/Failed:\s+(\d+)/);
        data.p50 = match(/Reconnect p50:\s+(\d+)ms/);
        data.p95 = match(/Reconnect p95:\s+(\d+)ms/);
        data.p99 = match(/Reconnect p99:\s+(\d+)ms/);
        data.msgsPre = match(/Msgs pre-disconnect:\s+(\d+)/);
        data.msgsPost = match(/Msgs post-reconnect:\s+(\d+)/);
        return data;
      } catch { return {}; }
    }

    const rcWsText = parseReconnectText(path.join(RESULTS_DIR, 'reconnect-ws.txt'));
    const rcSseText = parseReconnectText(path.join(RESULTS_DIR, 'reconnect-sse.txt'));

    const rcData = [
      ['Reconnected clients', rcWsText.reconnected || 0, rcSseText.reconnected || 0, false],
      ['Failed reconnections', rcWsText.failed || 0, rcSseText.failed || 0, true],
      ['Reconnect p50 (ms)', rcWsText.p50 || 0, rcSseText.p50 || 0, true],
      ['Reconnect p95 (ms)', rcWsText.p95 || 0, rcSseText.p95 || 0, true],
      ['Reconnect p99 (ms)', rcWsText.p99 || 0, rcSseText.p99 || 0, true],
      ['Msgs pre-disconnect', rcWsText.msgsPre || 0, rcSseText.msgsPre || 0, false],
      ['Msgs post-reconnect', rcWsText.msgsPost || 0, rcSseText.msgsPost || 0, false],
    ];

    for (const [label, wsVal, sseVal, lowerBetter] of rcData) {
      let winner = '';
      if (typeof wsVal === 'number' && typeof sseVal === 'number') {
        if (label.includes('p50') || label.includes('p95') || label.includes('p99') || label.includes('Failed')) {
          winner = wsVal <= sseVal ? 'WebSocket' : 'SSE';
        }
      }
      const row = rcSheet.addRow({ metric: label, ws: wsVal, sse: sseVal, winner });
      if (rcSheet.rowCount % 2 === 0) {
        row.eachCell((c) => {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHTER_ROW } };
        });
      }
      if (winner) {
        row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WINNER_BG } };
        row.getCell(4).font = { bold: true };
      }
    }

    // Chart data
    rcSheet.addRow([]);
    const rcChartTitle = rcSheet.addRow(['Metric', 'WebSocket (ms)', 'SSE (ms)']);
    rcChartTitle.eachCell((c) => Object.assign(c, headerStyle()));
    rcSheet.addRow(['p50', rcWsText.p50 || 0, rcSseText.p50 || 0]);
    rcSheet.addRow(['p95', rcWsText.p95 || 0, rcSseText.p95 || 0]);
    rcSheet.addRow(['p99', rcWsText.p99 || 0, rcSseText.p99 || 0]);

    summary.addRow({
      metric: 'Reconnect p50 (ms)',
      ws: rcWsText.p50 || 0,
      sse: rcSseText.p50 || 0,
      winner: (rcWsText.p50 || 0) <= (rcSseText.p50 || 0) ? 'WebSocket' : 'SSE',
    });
  }

  // ========== SHEET 6: Payload Sweep ==========
  const psSheet = wb.addWorksheet('Payload Sweep', { properties: { tabColor: { argb: '70AD47' } } });
  psSheet.columns = [
    { header: 'Payload Size', key: 'size', width: 15 },
    { header: 'WS Received', key: 'wsRecv', width: 14 },
    { header: 'WS Avg Lat (ms)', key: 'wsLat', width: 17 },
    { header: 'WS p99 Lat (ms)', key: 'wsP99', width: 17 },
    { header: 'WS MB/s', key: 'wsMbs', width: 12 },
    { header: 'SSE Received', key: 'sseRecv', width: 14 },
    { header: 'SSE Avg Lat (ms)', key: 'sseLat', width: 17 },
    { header: 'SSE p99 Lat (ms)', key: 'sseP99', width: 17 },
    { header: 'SSE MB/s', key: 'sseMbs', width: 12 },
    { header: 'Winner', key: 'winner', width: 12 },
  ];
  const psHdr = psSheet.getRow(1);
  psHdr.eachCell((cell) => Object.assign(cell, headerStyle()));

  function parsePayloadSweepText(filePath) {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const rows = [];
      const lines = text.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*(\d+)B?\s*\|\s*(\d+)\s*\|\s*([\d.]+)ms\s*\|\s*([\d.]+)ms\s*\|\s*([\d.]+)/);
        if (match) {
          rows.push({
            size: parseInt(match[1]),
            received: parseInt(match[2]),
            avgLatency: parseFloat(match[3]),
            p99Latency: parseFloat(match[4]),
            throughputMBs: parseFloat(match[5]),
          });
        }
      }
      return rows;
    } catch { return []; }
  }

  const psWs = parsePayloadSweepText(path.join(RESULTS_DIR, 'payload-ws.txt'));
  const psSse = parsePayloadSweepText(path.join(RESULTS_DIR, 'payload-sse.txt'));

  const sizes = [64, 256, 1024, 4096, 16384, 65536];
  const sizeLabels = ['64B', '256B', '1KB', '4KB', '16KB', '64KB'];

  for (let i = 0; i < sizes.length; i++) {
    const ws = psWs.find(r => r.size === sizes[i]);
    const sse = psSse.find(r => r.size === sizes[i]);

    const wsLat = ws?.avgLatency ?? 0;
    const sseLat = sse?.avgLatency ?? 0;
    let winner = '';
    if (wsLat > 0 && sseLat > 0) {
      winner = wsLat <= sseLat ? 'WebSocket' : 'SSE';
    } else if (wsLat > 0) {
      winner = 'WebSocket';
    }

    const row = psSheet.addRow({
      size: sizeLabels[i],
      wsRecv: ws?.received ?? 0,
      wsLat: ws?.avgLatency ?? 0,
      wsP99: ws?.p99Latency ?? 0,
      wsMbs: ws?.throughputMBs ?? 0,
      sseRecv: sse?.received ?? 0,
      sseLat: sse?.avgLatency ?? '-',
      sseP99: sse?.p99Latency ?? '-',
      sseMbs: sse?.throughputMBs ?? 0,
      winner,
    });
    if (i % 2 === 0) {
      row.eachCell((c) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHTER_ROW } };
      });
    }
  }

  // Chart data
  psSheet.addRow([]);
  const psChartTitle = psSheet.addRow(['Size', 'WS Avg Latency (ms)', 'SSE Avg Latency (ms)']);
  psChartTitle.eachCell((c) => Object.assign(c, headerStyle()));
  for (let i = 0; i < sizes.length; i++) {
    const ws = psWs.find(r => r.size === sizes[i]);
    const sse = psSse.find(r => r.size === sizes[i]);
    psSheet.addRow([sizeLabels[i], ws?.avgLatency ?? 0, sse?.avgLatency ?? 0]);
  }

  psSheet.addRow([]);
  const psChartTitle2 = psSheet.addRow(['Size', 'WS Throughput (MB/s)', 'SSE Throughput (MB/s)']);
  psChartTitle2.eachCell((c) => Object.assign(c, headerStyle()));
  for (let i = 0; i < sizes.length; i++) {
    const ws = psWs.find(r => r.size === sizes[i]);
    const sse = psSse.find(r => r.size === sizes[i]);
    psSheet.addRow([sizeLabels[i], ws?.throughputMBs ?? 0, sse?.throughputMBs ?? 0]);
  }

  // ========== SHEET 7: Overall Verdict ==========
  const verdict = wb.addWorksheet('Verdict', { properties: { tabColor: { argb: '70AD47' } } });
  verdict.columns = [
    { header: 'Scenario', key: 'scenario', width: 35 },
    { header: 'Winner', key: 'winner', width: 15 },
    { header: 'Key Evidence', key: 'evidence', width: 55 },
  ];
  const vHdr = verdict.getRow(1);
  vHdr.eachCell((cell) => Object.assign(cell, headerStyle()));

  const echoWsL = echoWs?.latency || {};
  const echoSseL = echoSse?.latency || {};
  const foWsL = foWs?.latency || {};
  const foSseL = foSse?.latency || {};

  const verdictData = [
    ['Bidirectional (Echo/Chat)', 'WebSocket', `RTT p50: WS ${echoWsL.p50}ms vs SSE ${echoSseL.p50}ms (${Math.round((echoSseL.p50 || 1) / (echoWsL.p50 || 1))}x faster)`],
    ['High-Frequency Throughput', 'WebSocket', `@1000msg/s: WS ${tpWs.find(r => r.rate === 1000)?.delivery ?? 0}% delivery, SSE crashed`],
    ['Large Payload (64KB)', 'WebSocket', `WS: ${psWs.find(r => r.size === 65536)?.avgLatency ?? 0}ms avg, SSE: failed to deliver`],
    ['Fan-Out Broadcast (1000)', 'Close/WS Edge', `p50: WS ${foWsL.p50}ms vs SSE ${foSseL.p50}ms`],
    ['Reconnection Speed', 'SSE', `p50: SSE ${rcSse ? parseFloat(fs.readFileSync(path.join(RESULTS_DIR, 'reconnect-sse.txt'), 'utf8').match(/p50:\s+(\d+)ms/)?.[1] || 0) : 0}ms vs WS ${rcWs ? parseFloat(fs.readFileSync(path.join(RESULTS_DIR, 'reconnect-ws.txt'), 'utf8').match(/p50:\s+(\d+)ms/)?.[1] || 0) : 0}ms`],
    ['Auto-Reconnect (built-in)', 'SSE', 'EventSource API handles reconnection + Last-Event-ID natively'],
    ['HTTP/2 Multiplexing', 'SSE', 'Multiple SSE streams share 1 TCP conn; WS needs 1 TCP per client'],
    ['Proxy/CDN Compatibility', 'SSE', 'Standard HTTP - works through any proxy without special config'],
    ['Binary Data', 'WebSocket', 'Native binary frames vs SSE base64 encoding (+33% overhead)'],
    ['Connection Setup', 'SSE', `WS needs HTTP Upgrade handshake; SSE is plain HTTP GET`],
  ];

  for (const [scenario, winner, evidence] of verdictData) {
    const row = verdict.addRow({ scenario, winner, evidence });
    row.getCell(2).font = { bold: true, color: { argb: winner === 'WebSocket' ? WS_COLOR : winner === 'SSE' ? SSE_COLOR : '000000' } };
  }

  verdict.addRow([]);
  verdict.addRow([]);
  const finalRow = verdict.addRow(['CONCLUSION: Neither protocol is universally better. Choose based on your use case.']);
  finalRow.font = { bold: true, size: 13 };
  verdict.mergeCells(finalRow.number, 1, finalRow.number, 3);

  verdict.addRow([]);
  verdict.addRow(['Use WebSocket when:', '', 'Bidirectional communication, real-time gaming, chat, high-frequency trading']);
  verdict.addRow(['Use SSE when:', '', 'One-way server push, notifications, dashboards, stock tickers, CDN-friendly streams']);

  // ========== Finalize summary styling ==========
  for (let i = 2; i <= summary.rowCount; i++) {
    const row = summary.getRow(i);
    const winnerCell = row.getCell(4);
    if (winnerCell.value) {
      winnerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WINNER_BG } };
      winnerCell.font = { bold: true };
    }
    if (i % 2 === 0) {
      for (let c = 1; c <= 3; c++) {
        row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHTER_ROW } };
      }
    }
  }

  // Save
  await wb.xlsx.writeFile(OUTPUT_FILE);
  console.log(`\nExcel report generated: ${OUTPUT_FILE}`);
  console.log(`\nSheets:`);
  console.log(`  1. Summary - Overall comparison at a glance`);
  console.log(`  2. Echo Round-Trip - Bidirectional latency comparison`);
  console.log(`  3. Throughput - Message rate ramp-up comparison`);
  console.log(`  4. Fan-Out Broadcast - 1000 passive clients`);
  console.log(`  5. Reconnection - Recovery after disconnect`);
  console.log(`  6. Payload Sweep - Message size impact`);
  console.log(`  7. Verdict - Final recommendations`);
}

main().catch(console.error);
