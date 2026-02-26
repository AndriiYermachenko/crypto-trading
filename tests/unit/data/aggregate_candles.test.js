'use strict';

const { aggregateCandlesFromTicks } = require('../../../data/utils/aggregate_candles');

describe('aggregateCandlesFromTicks', () => {
  test('builds ohlcv candles for timeframe window', () => {
    const ticks = [
      { timestamp: '2024-01-01T00:00:01Z', price: 100, volume: 1 },
      { timestamp: '2024-01-01T00:00:20Z', price: 105, volume: 2 },
      { timestamp: '2024-01-01T00:00:50Z', price: 99, volume: 1 },
      { timestamp: '2024-01-01T00:01:01Z', price: 103, volume: 3 },
    ];

    const candles = aggregateCandlesFromTicks(ticks, '1m');

    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({ open: 100, high: 105, low: 99, close: 99, volume: 4 });
    expect(candles[1]).toMatchObject({ open: 103, high: 103, low: 103, close: 103, volume: 3 });
  });
});
