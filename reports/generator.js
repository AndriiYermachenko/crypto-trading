'use strict';

const fs = require('fs');
const path = require('path');

const DAYS_PER_YEAR = 365;

function generateReport(input = {}, options = {}) {
  const tradeLogs = Array.isArray(input.tradeLogs) ? [...input.tradeLogs] : [];
  const equitySeries = Array.isArray(input.equitySeries) ? [...input.equitySeries] : [];

  tradeLogs.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  equitySeries.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  const outputDir = options.outputDir ?? path.join(process.cwd(), 'reports', 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  const initialCapital =
    options.initialCapital ??
    input.initialCapital ??
    (equitySeries.length > 0 ? Number(equitySeries[0].equity) : 0);

  const drawdownCurve = buildDrawdownCurve(equitySeries);
  const dailyReturns = buildPeriodReturns(equitySeries, 'day');
  const monthlyReturns = buildPeriodReturns(equitySeries, 'month');
  const rollingSharpe30d = buildRollingSharpe(dailyReturns, 30);

  const { trades, diagnostics } = buildTradeJournal({
    tradeLogs,
    equitySeries,
    initialCapital,
    feeRate: options.feeRate ?? 0,
  });

  const summary = buildSummaryMetrics({
    trades,
    equitySeries,
    dailyReturns,
    initialCapital,
    drawdownCurve,
  });

  writeTradesCsv(path.join(outputDir, 'trades.csv'), trades);
  writeSummaryJson(path.join(outputDir, 'summary.json'), {
    summary,
    diagnostics,
    series: {
      equityCurve: equitySeries,
      drawdownCurve,
      rollingSharpe30d,
      dailyReturns,
      monthlyReturns,
    },
  });

  if (options.exportEquityCsv !== false) {
    writeEquityCsv(path.join(outputDir, 'equity.csv'), equitySeries, drawdownCurve);
  }

  const chartArtifacts = createChartsIfAvailable({
    outputDir,
    equitySeries,
    drawdownCurve,
    dailyReturns,
  });

  return {
    trades,
    summary,
    diagnostics,
    series: {
      equityCurve: equitySeries,
      drawdownCurve,
      rollingSharpe30d,
      dailyReturns,
      monthlyReturns,
    },
    files: {
      tradesCsv: path.join(outputDir, 'trades.csv'),
      summaryJson: path.join(outputDir, 'summary.json'),
      equityCsv: options.exportEquityCsv === false ? null : path.join(outputDir, 'equity.csv'),
      charts: chartArtifacts,
    },
  };
}

function buildTradeJournal({ tradeLogs, equitySeries, initialCapital, feeRate }) {
  const orderById = new Map();
  const trades = [];
  const slippageByTrade = [];
  const liquidityRejections = [];
  const unfilledOrders = [];
  const orphanedFills = [];

  let currentPositionQty = 0;
  let avgEntryPrice = 0;
  let currentTrade = null;

  for (const log of tradeLogs) {
    if (log.type === 'order_submitted') {
      orderById.set(log.order_id, { ...log, status: 'submitted' });
      continue;
    }

    if (log.type === 'order_cancelled') {
      const order = orderById.get(log.order_id);
      if (order) {
        order.status = 'cancelled';
        order.cancelled_at = log.timestamp;
        order.cancel_reason = log.reason;
      }

      const reason = String(log.reason ?? '').toLowerCase();
      if (reason.includes('liquidity') || reason.includes('reject') || reason.includes('insufficient')) {
        liquidityRejections.push({
          timestamp: log.timestamp,
          order_id: log.order_id,
          reason: log.reason ?? 'unknown',
        });
      }
      continue;
    }

    if (log.type !== 'order_filled') {
      continue;
    }

    const fillPrice = Number(log.price ?? 0);
    const fillQtyAbs = Math.abs(Number(log.qty ?? 0));
    const signedQty = log.side === 'sell' ? -fillQtyAbs : fillQtyAbs;
    const notional = fillQtyAbs * fillPrice;

    const linkedOrder = orderById.get(log.order_id);
    if (!linkedOrder) {
      orphanedFills.push({
        timestamp: log.timestamp,
        order_id: log.order_id,
        side: log.side,
        qty: fillQtyAbs,
        price: fillPrice,
      });
    } else {
      linkedOrder.status = 'filled';
      linkedOrder.filled_at = log.timestamp;
    }

    const referencePrice = Number(
      log.reference_price ?? linkedOrder?.price ?? linkedOrder?.reference_price ?? fillPrice,
    );
    const slippageBps = referencePrice === 0
      ? 0
      : ((fillPrice - referencePrice) / referencePrice) * (log.side === 'buy' ? 1 : -1) * 10000;

    const fees = Number(log.fees ?? log.fee ?? notional * feeRate);
    const leverage = Number(log.leverage ?? estimateLeverage(notional, equitySeries, log.timestamp, initialCapital));

    if (currentPositionQty === 0 && signedQty !== 0) {
      currentTrade = {
        trade_id: `T${trades.length + 1}`,
        entry_timestamp: log.timestamp,
        exit_timestamp: null,
        direction: signedQty > 0 ? 'long' : 'short',
        entry_price: fillPrice,
        exit_price: null,
        qty: Math.abs(signedQty),
        gross_pnl: 0,
        net_pnl: 0,
        fees,
        slippage_bps: slippageBps,
        leverage,
        fill_count: 1,
      };
      avgEntryPrice = fillPrice;
      currentPositionQty = signedQty;
      continue;
    }

    if (!currentTrade) {
      continue;
    }

    const priorQty = currentPositionQty;
    const nextQty = priorQty + signedQty;
    const isReducing = priorQty !== 0 && Math.sign(priorQty) !== Math.sign(signedQty);

    if (isReducing) {
      const closeQty = Math.min(Math.abs(priorQty), fillQtyAbs);
      const closedPnl = Math.sign(priorQty) * closeQty * (fillPrice - avgEntryPrice);

      currentTrade.gross_pnl += closedPnl;
      currentTrade.fees += fees;
      currentTrade.slippage_bps += slippageBps;
      currentTrade.fill_count += 1;
      currentTrade.qty = Math.max(currentTrade.qty, Math.abs(priorQty));

      if (nextQty === 0) {
        currentTrade.exit_timestamp = log.timestamp;
        currentTrade.exit_price = fillPrice;
        currentTrade.net_pnl = currentTrade.gross_pnl - currentTrade.fees;
        currentTrade.slippage_bps = currentTrade.slippage_bps / currentTrade.fill_count;
        currentTrade.max_intra_trade_dd = computeIntraTradeDrawdown(
          equitySeries,
          currentTrade.entry_timestamp,
          currentTrade.exit_timestamp,
        );

        trades.push(currentTrade);
        slippageByTrade.push({
          trade_id: currentTrade.trade_id,
          timestamp: currentTrade.exit_timestamp,
          slippage_bps: currentTrade.slippage_bps,
        });
        currentTrade = null;
      }
    } else {
      const totalQty = Math.abs(priorQty) + fillQtyAbs;
      avgEntryPrice = totalQty === 0
        ? 0
        : ((avgEntryPrice * Math.abs(priorQty)) + (fillPrice * fillQtyAbs)) / totalQty;

      currentTrade.fees += fees;
      currentTrade.slippage_bps += slippageBps;
      currentTrade.fill_count += 1;
      currentTrade.qty = Math.max(currentTrade.qty, Math.abs(nextQty));
      currentTrade.leverage = Math.max(currentTrade.leverage, leverage);
    }

    currentPositionQty = nextQty;
  }

  for (const [orderId, order] of orderById.entries()) {
    if (order.status === 'submitted') {
      unfilledOrders.push({
        order_id: orderId,
        timestamp: order.timestamp,
        side: order.side,
        qty: order.qty,
        price: order.price,
      });
    }
  }

  return {
    trades,
    diagnostics: {
      slippageByTrade,
      liquidityRejections,
      unfilledOrders,
      orphanedFills,
    },
  };
}

function buildSummaryMetrics({ trades, equitySeries, dailyReturns, initialCapital, drawdownCurve }) {
  const netPnl = sum(trades.map((trade) => trade.net_pnl));
  const grossProfit = sum(trades.filter((trade) => trade.gross_pnl > 0).map((trade) => trade.gross_pnl));
  const grossLoss = sum(trades.filter((trade) => trade.gross_pnl < 0).map((trade) => trade.gross_pnl));
  const profitFactor = grossLoss === 0 ? null : grossProfit / Math.abs(grossLoss);

  const wins = trades.filter((trade) => trade.net_pnl > 0);
  const losses = trades.filter((trade) => trade.net_pnl < 0);

  const expectancy = trades.length === 0 ? 0 : netPnl / trades.length;
  const winRate = trades.length === 0 ? 0 : wins.length / trades.length;
  const avgWin = wins.length === 0 ? 0 : sum(wins.map((trade) => trade.net_pnl)) / wins.length;
  const avgLoss = losses.length === 0 ? 0 : sum(losses.map((trade) => trade.net_pnl)) / losses.length;

  const firstEquity = equitySeries.length > 0 ? Number(equitySeries[0].equity) : Number(initialCapital ?? 0);
  const lastEquity = equitySeries.length > 0
    ? Number(equitySeries[equitySeries.length - 1].equity)
    : Number(initialCapital ?? 0);

  const spanYears = computeSpanYears(equitySeries);
  const cagr = spanYears > 0 && firstEquity > 0
    ? Math.pow(lastEquity / firstEquity, 1 / spanYears) - 1
    : 0;

  const sharpe = computeSharpe(dailyReturns.map((entry) => entry.return));
  const sortino = computeSortino(dailyReturns.map((entry) => entry.return));

  const maxDrawdown = drawdownCurve.length === 0
    ? 0
    : Math.min(...drawdownCurve.map((entry) => entry.drawdown));

  const recoveryFactor = maxDrawdown === 0 ? null : netPnl / Math.abs(maxDrawdown * firstEquity);

  return {
    trade_count: trades.length,
    win_rate: winRate,
    gross_profit: grossProfit,
    gross_loss: grossLoss,
    net_pnl: netPnl,
    profit_factor: profitFactor,
    expectancy,
    average_win: avgWin,
    average_loss: avgLoss,
    cagr,
    sharpe,
    sortino,
    max_drawdown: maxDrawdown,
    recovery_factor: recoveryFactor,
    start_equity: firstEquity,
    end_equity: lastEquity,
  };
}

function buildDrawdownCurve(equitySeries) {
  const result = [];
  let peak = -Infinity;

  for (const entry of equitySeries) {
    const equity = Number(entry.equity ?? 0);
    peak = Math.max(peak, equity);
    const drawdown = peak === 0 ? 0 : (equity - peak) / peak;

    result.push({
      timestamp: entry.timestamp,
      drawdown,
    });
  }

  return result;
}

function buildPeriodReturns(equitySeries, period) {
  const buckets = new Map();

  for (const point of equitySeries) {
    const date = new Date(point.timestamp);
    if (Number.isNaN(date.getTime())) {
      continue;
    }

    const key = period === 'month'
      ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
      : date.toISOString().slice(0, 10);

    if (!buckets.has(key)) {
      buckets.set(key, { start: point.equity, end: point.equity, timestamp: point.timestamp });
    } else {
      const bucket = buckets.get(key);
      bucket.end = point.equity;
      bucket.timestamp = point.timestamp;
    }
  }

  const output = [];
  for (const [key, bucket] of buckets.entries()) {
    const start = Number(bucket.start ?? 0);
    const end = Number(bucket.end ?? 0);
    const r = start === 0 ? 0 : (end - start) / start;

    output.push({
      period: key,
      timestamp: bucket.timestamp,
      return: r,
    });
  }

  output.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return output;
}

function buildRollingSharpe(dailyReturns, window) {
  const values = dailyReturns.map((entry) => Number(entry.return ?? 0));
  const out = [];

  for (let i = 0; i < dailyReturns.length; i += 1) {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    out.push({
      timestamp: dailyReturns[i].timestamp,
      rolling_sharpe: computeSharpe(slice),
    });
  }

  return out;
}

function computeIntraTradeDrawdown(equitySeries, entryTs, exitTs) {
  let peak = -Infinity;
  let maxDd = 0;

  for (const point of equitySeries) {
    const ts = point.timestamp ?? 0;
    if (ts < entryTs || ts > exitTs) {
      continue;
    }

    const equity = Number(point.equity ?? 0);
    peak = Math.max(peak, equity);
    const dd = peak === 0 ? 0 : (equity - peak) / peak;
    maxDd = Math.min(maxDd, dd);
  }

  return maxDd;
}

function estimateLeverage(notional, equitySeries, timestamp, initialCapital) {
  const equity = findEquityAt(equitySeries, timestamp) ?? Number(initialCapital ?? 0);
  if (!equity) {
    return 0;
  }
  return Math.abs(notional / equity);
}

function findEquityAt(equitySeries, timestamp) {
  let candidate = null;
  for (const point of equitySeries) {
    if ((point.timestamp ?? 0) <= timestamp) {
      candidate = Number(point.equity ?? 0);
    } else {
      break;
    }
  }
  return candidate;
}

function computeSharpe(returns) {
  if (!returns || returns.length < 2) {
    return 0;
  }

  const mean = average(returns);
  const std = stddev(returns);
  if (std === 0) {
    return 0;
  }

  return (mean / std) * Math.sqrt(DAYS_PER_YEAR);
}

function computeSortino(returns) {
  if (!returns || returns.length < 2) {
    return 0;
  }

  const mean = average(returns);
  const downside = returns.filter((value) => value < 0);
  const downsideStd = stddev(downside);
  if (downsideStd === 0) {
    return 0;
  }

  return (mean / downsideStd) * Math.sqrt(DAYS_PER_YEAR);
}

function computeSpanYears(equitySeries) {
  if (!equitySeries || equitySeries.length < 2) {
    return 0;
  }

  const first = equitySeries[0].timestamp;
  const last = equitySeries[equitySeries.length - 1].timestamp;
  const years = (last - first) / (1000 * 60 * 60 * 24 * DAYS_PER_YEAR);
  return years > 0 ? years : 0;
}

function writeTradesCsv(filePath, trades) {
  const header = [
    'trade_id',
    'entry_timestamp',
    'exit_timestamp',
    'direction',
    'entry_price',
    'exit_price',
    'qty',
    'gross_pnl',
    'net_pnl',
    'fees',
    'slippage_bps',
    'leverage',
    'max_intra_trade_dd',
  ];

  const rows = trades.map((trade) => [
    trade.trade_id,
    trade.entry_timestamp,
    trade.exit_timestamp,
    trade.direction,
    trade.entry_price,
    trade.exit_price,
    trade.qty,
    trade.gross_pnl,
    trade.net_pnl,
    trade.fees,
    trade.slippage_bps,
    trade.leverage,
    trade.max_intra_trade_dd,
  ]);

  writeCsv(filePath, header, rows);
}

function writeEquityCsv(filePath, equitySeries, drawdownCurve) {
  const drawdownByTs = new Map(drawdownCurve.map((entry) => [entry.timestamp, entry.drawdown]));
  const header = ['timestamp', 'equity', 'cash', 'margin', 'position_qty', 'position_avg_price', 'drawdown'];
  const rows = equitySeries.map((point) => [
    point.timestamp,
    point.equity,
    point.cash,
    point.margin,
    point.position_qty,
    point.position_avg_price,
    drawdownByTs.get(point.timestamp) ?? 0,
  ]);

  writeCsv(filePath, header, rows);
}

function writeSummaryJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeCsv(filePath, header, rows) {
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function csvEscape(value) {
  if (value == null) {
    return '';
  }

  const s = String(value);
  if (!/[",\n]/.test(s)) {
    return s;
  }

  return `"${s.replace(/"/g, '""')}"`;
}

function createChartsIfAvailable({ outputDir, equitySeries, drawdownCurve, dailyReturns }) {
  let ChartJSNodeCanvas;
  try {
    ({ ChartJSNodeCanvas } = require('chartjs-node-canvas'));
  } catch (_err) {
    return {
      enabled: false,
      reason: 'chartjs-node-canvas not installed',
      files: [],
    };
  }

  const width = 1200;
  const height = 600;
  const chartCanvas = new ChartJSNodeCanvas({ width, height, backgroundColour: 'white' });

  const files = [];

  const equityPath = path.join(outputDir, 'equity.png');
  renderLineChart(chartCanvas, {
    labels: equitySeries.map((point) => isoTs(point.timestamp)),
    values: equitySeries.map((point) => Number(point.equity ?? 0)),
    label: 'Equity',
    yLabel: 'Equity',
    filePath: equityPath,
  });
  files.push(equityPath);

  const drawdownPath = path.join(outputDir, 'drawdown.png');
  renderLineChart(chartCanvas, {
    labels: drawdownCurve.map((point) => isoTs(point.timestamp)),
    values: drawdownCurve.map((point) => Number(point.drawdown ?? 0)),
    label: 'Drawdown',
    yLabel: 'Drawdown',
    filePath: drawdownPath,
  });
  files.push(drawdownPath);

  const histogramPath = path.join(outputDir, 'returns-histogram.png');
  renderHistogramChart(chartCanvas, dailyReturns.map((entry) => Number(entry.return ?? 0)), histogramPath);
  files.push(histogramPath);

  return {
    enabled: true,
    files,
  };
}

function renderLineChart(chartCanvas, { labels, values, label, yLabel, filePath }) {
  const configuration = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label,
          data: values,
          borderColor: '#2563eb',
          borderWidth: 2,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: false,
      scales: {
        y: { title: { display: true, text: yLabel } },
        x: { ticks: { maxTicksLimit: 12 } },
      },
    },
  };

  const buffer = chartCanvas.renderToBufferSync(configuration);
  fs.writeFileSync(filePath, buffer);
}

function renderHistogramChart(chartCanvas, values, filePath) {
  const bins = buildHistogram(values, 24);
  const configuration = {
    type: 'bar',
    data: {
      labels: bins.map((bin) => `${(bin.min * 100).toFixed(2)}%..${(bin.max * 100).toFixed(2)}%`),
      datasets: [
        {
          label: 'Daily returns histogram',
          data: bins.map((bin) => bin.count),
          backgroundColor: '#10b981',
        },
      ],
    },
    options: {
      responsive: false,
      scales: {
        x: { ticks: { maxTicksLimit: 10 } },
      },
    },
  };

  const buffer = chartCanvas.renderToBufferSync(configuration);
  fs.writeFileSync(filePath, buffer);
}

function buildHistogram(values, count) {
  if (!values.length) {
    return [{ min: 0, max: 0, count: 0 }];
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = span / count;

  const bins = Array.from({ length: count }, (_, idx) => ({
    min: min + idx * step,
    max: min + (idx + 1) * step,
    count: 0,
  }));

  for (const value of values) {
    const normalized = (value - min) / span;
    const rawIndex = Math.floor(normalized * count);
    const index = Math.max(0, Math.min(count - 1, rawIndex));
    bins[index].count += 1;
  }

  return bins;
}

function isoTs(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return String(timestamp);
  }
  return date.toISOString();
}

function sum(values) {
  return values.reduce((acc, value) => acc + Number(value ?? 0), 0);
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return sum(values) / values.length;
}

function stddev(values) {
  if (!values.length) {
    return 0;
  }

  const mean = average(values);
  const variance = average(values.map((value) => {
    const delta = value - mean;
    return delta * delta;
  }));

  return Math.sqrt(variance);
}

module.exports = {
  generateReport,
  buildTradeJournal,
  buildSummaryMetrics,
  buildDrawdownCurve,
  buildPeriodReturns,
  buildRollingSharpe,
};
