'use strict';

const TIMEFRAME_TO_MS = Object.freeze({
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
});

function aggregateCandlesFromTicks(ticks, timeframe) {
  if (!Array.isArray(ticks)) {
    throw new Error('ticks must be an array');
  }

  const windowMs = TIMEFRAME_TO_MS[timeframe];
  if (!windowMs) {
    throw new Error(`Unsupported timeframe: ${timeframe}`);
  }

  const sortedTicks = ticks
    .map(normalizeTick)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (sortedTicks.length === 0) {
    return [];
  }

  const candles = [];
  let current = null;

  for (const tick of sortedTicks) {
    const bucketStart = Math.floor(tick.timestamp / windowMs) * windowMs;

    if (!current || current.timestamp !== bucketStart) {
      current = {
        type: 'candle',
        timestamp: bucketStart,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.volume,
      };
      candles.push(current);
      continue;
    }

    current.high = Math.max(current.high, tick.price);
    current.low = Math.min(current.low, tick.price);
    current.close = tick.price;
    current.volume += tick.volume;
  }

  return candles;
}

function normalizeTick(tick) {
  if (!tick || typeof tick !== 'object') {
    throw new Error('tick must be an object');
  }
  if (!Number.isFinite(tick.price)) {
    throw new Error('tick.price must be a finite number');
  }

  const timestamp = normalizeTimestamp(tick.timestamp);
  const volume = tick.volume == null ? 0 : Number(tick.volume);
  if (!Number.isFinite(volume) || volume < 0) {
    throw new Error('tick.volume must be a non-negative number when provided');
  }

  return {
    type: 'tick',
    ...tick,
    timestamp,
    volume,
  };
}

function normalizeTimestamp(timestamp) {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return timestamp;
  }

  const parsed = new Date(timestamp).getTime();
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid timestamp: ${timestamp}`);
  }
  return parsed;
}

module.exports = {
  aggregateCandlesFromTicks,
  TIMEFRAME_TO_MS,
};
