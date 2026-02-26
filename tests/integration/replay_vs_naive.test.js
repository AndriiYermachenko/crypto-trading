'use strict';

const { BacktestEngine } = require('../../engine');
const { EmaCrossStrategy } = require('../../strategies/ema_cross');

function makeEvents() {
  const prices = [100, 101, 102, 103, 102, 101, 100, 99, 98, 99, 100, 101, 102, 103];
  return prices.map((close, i) => ({ type: 'candle', timestamp: i + 1, close, open: close, high: close, low: close, price: close }));
}

function adapter(events) {
  return { async load() { return events; } };
}

function naiveReplay(events, strategy, initialCash = 1000) {
  const state = { cash: initialCash, qty: 0, avg: 0, equity: initialCash };
  for (const event of events) {
    const signals = strategy.onEvent(event, { state, random: () => 0.5 });
    for (const sig of signals) {
      const side = sig.side;
      const signedQty = side === 'buy' ? Math.abs(sig.qty) : -Math.abs(sig.qty);
      const px = sig.price ?? event.close;
      state.cash -= signedQty * px;
      const prevQty = state.qty;
      const newQty = prevQty + signedQty;
      if (newQty === 0) {
        state.avg = 0;
      } else if (prevQty === 0 || Math.sign(prevQty) === Math.sign(newQty)) {
        state.avg = ((prevQty * state.avg) + (signedQty * px)) / newQty;
      } else {
        state.avg = px;
      }
      state.qty = newQty;
    }
    state.equity = state.cash + (state.qty * (event.close - state.avg));
  }
  return state.equity;
}

describe('integration replay: engine vs naive executor', () => {
  test('short period replay is close to reference naive executor', async () => {
    const events = makeEvents();
    const strategyForEngine = new EmaCrossStrategy({
      short_period: 2,
      long_period: 4,
      sizing: { mode: 'fixed_amount', amount: 1 },
    });
    const strategyForNaive = new EmaCrossStrategy({
      short_period: 2,
      long_period: 4,
      sizing: { mode: 'fixed_amount', amount: 1 },
    });

    const engine = new BacktestEngine({ random_seed: 7 });
    engine.setAdapter(adapter(events));
    engine.setStrategy(strategyForEngine);

    const result = await engine.run({
      symbol: 'BTC/USDT', timeframe: '1m', market_type: 'spot', start_date: 0, end_date: 999, initial_cash: 1000, random_seed: 7,
    });

    const naiveEquity = naiveReplay(events, strategyForNaive, 1000);
    expect(result.finalState.equity).toBeCloseTo(naiveEquity, 6);
  });
});
