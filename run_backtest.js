#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { BacktestEngine } = require('./engine');
const { EmaCrossStrategy } = require('./strategies/ema_cross');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }

    const [rawKey, inline] = token.slice(2).split('=');
    const key = rawKey.replace(/-/g, '_');
    if (inline != null) {
      args[key] = inline;
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

function toNumber(value, fallback) {
  if (value == null) {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseCsvCandles(text) {
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (rows.length <= 1) {
    return [];
  }

  const headers = rows[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

  return rows.slice(1).map((line) => {
    const cols = line.split(',').map((c) => c.trim());
    const ts = cols[idx.timestamp] ?? cols[idx.ts] ?? cols[idx.time];
    const close = Number(cols[idx.close] ?? cols[idx.price]);
    const open = Number(cols[idx.open] ?? close);
    const high = Number(cols[idx.high] ?? close);
    const low = Number(cols[idx.low] ?? close);
    const volume = Number(cols[idx.volume] ?? 0);
    return {
      type: 'candle',
      timestamp: Number.isFinite(Number(ts)) ? Number(ts) : ts,
      open,
      high,
      low,
      close,
      volume,
      price: close,
    };
  });
}

function buildDataAdapter(events) {
  return {
    async load(params) {
      const start = new Date(params.start_date).getTime();
      const end = new Date(params.end_date).getTime();
      return events.filter((event) => {
        const ts = typeof event.timestamp === 'number' ? event.timestamp : new Date(event.timestamp).getTime();
        return ts >= start && ts <= end;
      });
    },
  };
}

function writeTradesCsv(filePath, trades) {
  const header = ['timestamp', 'type', 'order_id', 'side', 'qty', 'price', 'cash_after', 'reason'];
  const lines = [header.join(',')];
  for (const trade of trades) {
    lines.push([
      trade.timestamp ?? '',
      trade.type ?? '',
      trade.order_id ?? '',
      trade.side ?? '',
      trade.qty ?? '',
      trade.price ?? '',
      trade.cash_after ?? '',
      trade.reason ?? '',
    ].join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help === 'true') {
    console.log('Usage: node run_backtest.js --strategy ema_cross --symbol BTC/USDT --from 2024-01-01 --to 2024-01-02 --tf 1m --data ./data/candles.csv');
    process.exit(0);
  }

  const configPath = args.config || path.join(__dirname, 'config/default.json');
  const config = loadJson(configPath);
  const strategyName = args.strategy || 'ema_cross';
  if (strategyName !== 'ema_cross') {
    throw new Error(`Unsupported strategy: ${strategyName}`);
  }

  const dataPath = args.data;
  if (!dataPath) {
    throw new Error('--data is required (csv or json with candles)');
  }

  const raw = fs.readFileSync(dataPath, 'utf8');
  const events = dataPath.endsWith('.json') ? JSON.parse(raw) : parseCsvCandles(raw);

  const strategy = new EmaCrossStrategy({
    short_period: toNumber(args.ema_short, 9),
    long_period: toNumber(args.ema_long, 21),
    stop_loss_pct: toNumber(args.stop, 0),
    take_profit_pct: toNumber(args.take, 0),
    sizing: {
      mode: args.sizing || 'fixed_amount',
      amount: toNumber(args.amount, 1),
      percent: toNumber(args.percent, 0.1),
      risk_pct: toNumber(args.risk, 0.01),
    },
  });

  const engine = new BacktestEngine({ random_seed: toNumber(args.random_seed, 1) });
  engine.setAdapter(buildDataAdapter(events));
  engine.setStrategy(strategy);

  const result = await engine.run({
    symbol: args.symbol || config.market.symbol,
    timeframe: args.tf || config.timeframe,
    market_type: args.market_type || config.market.type,
    start_date: args.from,
    end_date: args.to,
    initial_cash: toNumber(args.initial, 10000),
    random_seed: toNumber(args.random_seed, 1),
  });

  const summary = {
    symbol: args.symbol || config.market.symbol,
    timeframe: args.tf || config.timeframe,
    from: args.from,
    to: args.to,
    strategy: strategyName,
    trades: result.tradeLogs.filter((x) => x.type === 'order_filled').length,
    final_equity: result.finalState.equity,
    final_cash: result.finalState.cash,
    final_position_qty: result.finalState.position.qty,
    liquidated: result.finalState.liquidated,
  };

  const outDir = args.out_dir || path.join(process.cwd(), 'artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  const summaryPath = path.join(outDir, 'summary.json');
  const tradesPath = path.join(outDir, 'trades.csv');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  writeTradesCsv(tradesPath, result.tradeLogs);

  console.log(`Backtest completed.\nsummary: ${summaryPath}\ntrades: ${tradesPath}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
