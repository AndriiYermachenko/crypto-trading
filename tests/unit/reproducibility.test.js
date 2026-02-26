'use strict';

const { BacktestEngine } = require('../../engine');

function replayAdapter() {
  const events = [];
  for (let i = 0; i < 15; i += 1) {
    events.push({ type: 'candle', timestamp: i + 1, close: 100 + i });
    if (i % 3 === 0) {
      events.push({ type: 'signal_generated', timestamp: i + 1, side: i % 2 === 0 ? 'buy' : 'sell', qty: 0.1, price: 100 + i });
    }
  }
  return { async load() { return events; } };
}

const strategy = { onEvent: () => [] };

describe('reproducibility', () => {
  test('same random_seed yields identical equity curve', async () => {
    const mkEngine = async () => {
      const engine = new BacktestEngine({ random_seed: 42 });
      engine.setAdapter(replayAdapter());
      engine.setStrategy(strategy);
      return engine.run({
        symbol: 'BTC/USDT', timeframe: '1m', market_type: 'spot', start_date: 0, end_date: 999, initial_cash: 1000, random_seed: 42,
      });
    };

    const [runA, runB] = await Promise.all([mkEngine(), mkEngine()]);
    expect(runA.equitySeries).toEqual(runB.equitySeries);
    expect(runA.tradeLogs).toEqual(runB.tradeLogs);
  });
});
