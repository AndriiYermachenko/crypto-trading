'use strict';

const axios = require('axios');
const WebSocket = require('ws');

class BinanceReplayAdapter {
  constructor(options = {}) {
    this.options = {
      restEndpoint: options.restEndpoint ?? 'https://testnet.binance.vision',
      wsEndpoint: options.wsEndpoint ?? 'wss://testnet.binance.vision/ws',
      useWebsocket: options.useWebsocket ?? false,
      limit: options.limit ?? 1000,
      timeoutMs: options.timeoutMs ?? 5000,
      wsSessionMs: options.wsSessionMs ?? 1200,
    };
  }

  async load(params = {}) {
    const events = [];
    for await (const event of this.iterateEvents(params)) {
      events.push(event);
    }
    return events;
  }

  async *iterateEvents(params = {}) {
    const symbol = resolveSymbol(params.symbol);
    const interval = params.timeframe ?? '1m';
    const startTime = normalizeTimestamp(params.start_date);
    const endTime = normalizeTimestamp(params.end_date);

    const historical = await fetchKlines({
      endpoint: this.options.restEndpoint,
      symbol,
      interval,
      startTime,
      endTime,
      limit: this.options.limit,
      timeoutMs: this.options.timeoutMs,
    });

    for (const candle of historical) {
      yield candle;
    }

    if (this.options.useWebsocket) {
      for await (const event of streamKlines({
        wsEndpoint: this.options.wsEndpoint,
        symbol,
        interval,
        timeoutMs: this.options.timeoutMs,
        wsSessionMs: this.options.wsSessionMs,
      })) {
        if (event.timestamp > endTime) {
          break;
        }
        yield event;
      }
    }
  }
}

async function fetchKlines({ endpoint, symbol, interval, startTime, endTime, limit, timeoutMs }) {
  const url = `${endpoint}/api/v3/klines`;
  const { data } = await axios.get(url, {
    timeout: timeoutMs,
    params: { symbol, interval, startTime, endTime, limit },
  });

  if (!Array.isArray(data)) {
    throw new Error('Unexpected Binance klines response format');
  }

  return data.map((kline) => ({
    type: 'candle',
    timestamp: Number(kline[0]),
    open: Number(kline[1]),
    high: Number(kline[2]),
    low: Number(kline[3]),
    close: Number(kline[4]),
    volume: Number(kline[5]),
    source: 'binance_rest',
  }));
}

async function *streamKlines({ wsEndpoint, symbol, interval, timeoutMs, wsSessionMs }) {
  const streamName = `${symbol.toLowerCase()}@kline_${interval}`;
  const ws = new WebSocket(`${wsEndpoint}/${streamName}`);

  const queue = [];
  let done = false;
  let error;

  ws.on('message', (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      if (!payload || !payload.k) {
        return;
      }
      const k = payload.k;
      queue.push({
        type: 'candle',
        timestamp: Number(k.t),
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v),
        source: 'binance_ws',
      });
    } catch (err) {
      error = err;
      done = true;
    }
  });

  ws.on('error', (err) => {
    error = err;
    done = true;
  });

  ws.on('close', () => {
    done = true;
  });

  const hardStop = Date.now() + wsSessionMs;

  while (!done || queue.length > 0) {
    if (error) {
      ws.terminate();
      throw error;
    }

    while (queue.length > 0) {
      yield queue.shift();
    }

    if (Date.now() > hardStop) {
      ws.terminate();
      break;
    }

    await sleep(Math.min(timeoutMs, 100));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSymbol(symbol) {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new Error('symbol is required for Binance replay adapter');
  }
  return symbol.trim().toUpperCase();
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return parsed;
}

module.exports = {
  BinanceReplayAdapter,
  fetchKlines,
};
