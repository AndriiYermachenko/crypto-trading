'use strict';

const { BacktestEngine } = require('../../../engine');

describe('sanity warning for coarse candles', () => {
  test('warns when only 1m candles are provided', async () => {
    const engine = new BacktestEngine();
    engine.setAdapter({
      async load() {
        return [{ type: 'candle', timestamp: 1704067200000, open: 1, high: 1, low: 1, close: 1 }];
      },
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await engine.loadData({
      symbol: 'BTCUSDT',
      timeframe: '1m',
      market_type: 'spot',
      start_date: '2024-01-01T00:00:00Z',
      end_date: '2024-01-01T00:01:00Z',
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('only 1m candles'));
    warnSpy.mockRestore();
  });
});
