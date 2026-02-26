'use strict';

const fs = require('fs/promises');
const path = require('path');
const { TIMEFRAME_TO_MS } = require('../utils/aggregate_candles');

class CsvAdapter {
  constructor(options = {}) {
    this.options = {
      duplicate_policy: options.duplicate_policy ?? 'drop',
      missing_data_policy: options.missing_data_policy ?? 'drop',
    };
  }

  async load(params = {}) {
    const filePath = params.data_path ?? this.options.data_path;
    if (!filePath) {
      throw new Error('CSV adapter requires data_path');
    }

    const raw = await fs.readFile(filePath, 'utf8');
    const ext = path.extname(filePath).toLowerCase();
    const parsedRows = ext === '.json' ? parseJsonRows(raw) : parseCsvRows(raw);

    const normalized = parsedRows.map((row) => normalizeRow(row));
    const deduplicated = this.applyDuplicatePolicy(normalized);
    const gapHandled = this.applyMissingDataPolicy(deduplicated, params);

    return gapHandled.sort((a, b) => a.timestamp - b.timestamp);
  }

  applyDuplicatePolicy(rows) {
    if (this.options.duplicate_policy === 'reject') {
      const seen = new Set();
      for (const row of rows) {
        const key = `${row.type}:${row.timestamp}`;
        if (seen.has(key)) {
          throw new Error(`Duplicate data point detected for ${key}`);
        }
        seen.add(key);
      }
      return rows;
    }

    const out = [];
    const seen = new Set();
    for (const row of rows) {
      const key = `${row.type}:${row.timestamp}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(row);
    }

    return out;
  }

  applyMissingDataPolicy(rows, params) {
    if (rows.length === 0) {
      return rows;
    }

    const policy = this.options.missing_data_policy;
    if (policy === 'drop') {
      return rows;
    }

    const candleRows = rows.filter((row) => row.type === 'candle');
    const tickRows = rows.filter((row) => row.type === 'tick');

    if (policy === 'reject') {
      if (tickRows.length > 0) {
        return rows;
      }
      assertNoCandleGaps(candleRows, params.timeframe);
      return rows;
    }

    if (policy === 'interpolate') {
      if (tickRows.length > 0) {
        return rows;
      }
      const interpolated = interpolateCandleGaps(candleRows, params.timeframe);
      return interpolated;
    }

    throw new Error(`Unsupported missing_data_policy: ${policy}`);
  }
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') {
    throw new Error('each data row must be an object');
  }

  const timestamp = normalizeTimestamp(row.timestamp ?? row.time ?? row.open_time);

  if (row.price != null) {
    return {
      type: 'tick',
      timestamp,
      price: toNumber(row.price, 'price'),
      volume: row.volume == null ? 0 : toNumber(row.volume, 'volume'),
    };
  }

  if (row.open != null && row.high != null && row.low != null && row.close != null) {
    return {
      type: 'candle',
      timestamp,
      open: toNumber(row.open, 'open'),
      high: toNumber(row.high, 'high'),
      low: toNumber(row.low, 'low'),
      close: toNumber(row.close, 'close'),
      volume: row.volume == null ? 0 : toNumber(row.volume, 'volume'),
    };
  }

  throw new Error('row must represent either tick (price) or candle (open/high/low/close)');
}

function interpolateCandleGaps(candles, timeframe) {
  const interval = resolveTimeframeMs(timeframe);
  if (candles.length < 2) {
    return candles;
  }

  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const out = [];

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];
    out.push(current);

    const gap = next.timestamp - current.timestamp;
    if (gap <= interval) {
      continue;
    }

    const missingBars = Math.floor(gap / interval) - 1;
    for (let step = 1; step <= missingBars; step += 1) {
      const t = step / (missingBars + 1);
      const open = lerp(current.open, next.open, t);
      const high = lerp(current.high, next.high, t);
      const low = lerp(current.low, next.low, t);
      const close = lerp(current.close, next.close, t);
      const volume = lerp(current.volume ?? 0, next.volume ?? 0, t);
      out.push({ type: 'candle', timestamp: current.timestamp + interval * step, open, high, low, close, volume });
    }
  }

  out.push(sorted[sorted.length - 1]);
  return out;
}

function assertNoCandleGaps(candles, timeframe) {
  const interval = resolveTimeframeMs(timeframe);
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  for (let i = 1; i < sorted.length; i += 1) {
    const delta = sorted[i].timestamp - sorted[i - 1].timestamp;
    if (delta > interval) {
      throw new Error(`Missing candle data gap detected between ${sorted[i - 1].timestamp} and ${sorted[i].timestamp}`);
    }
  }
}

function resolveTimeframeMs(timeframe) {
  const interval = TIMEFRAME_TO_MS[timeframe];
  if (!interval) {
    throw new Error(`timeframe is required and must be one of: ${Object.keys(TIMEFRAME_TO_MS).join(', ')}`);
  }
  return interval;
}

function parseJsonRows(raw) {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.data;
}

function parseCsvRows(raw) {
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length === 0) {
    return [];
  }

  const header = splitCsvLine(lines[0]);
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = splitCsvLine(line);
    const row = {};
    header.forEach((h, idx) => {
      row[h] = cols[idx];
    });
    return row;
  });
}

function splitCsvLine(line) {
  return line.split(',').map((col) => col.trim());
}

function toNumber(value, field) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`${field} must be a finite number`);
  }
  return num;
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }

  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }

  return parsed;
}

module.exports = {
  CsvAdapter,
  normalizeRow,
  interpolateCandleGaps,
  assertNoCandleGaps,
};
