'use strict';

const { BacktestEngine } = require('../../engine');

function adapterWith(events) {
  return {
    async load() {
      return events;
    },
  };
}

function noopStrategy() {
  return { onEvent: () => [] };
}

describe('engine margin/liquidation and edge-cases', () => {
  test('handles margin update and liquidation closeout', async () => {
    const events = [
      { type: 'candle', timestamp: 1, close: 100 },
      { type: 'order_filled', timestamp: 2, order_id: 'x1', side: 'buy', qty: 1, price: 100 },
      { type: 'margin_update', timestamp: 3, margin: 50 },
      { type: 'liquidated', timestamp: 4, price: 90, reason: 'maintenance_margin_breach' },
    ];

    const engine = new BacktestEngine();
    engine.setAdapter(adapterWith(events));
    engine.setStrategy(noopStrategy());

    const result = await engine.run({
      symbol: 'BTC/USDT', timeframe: '1m', market_type: 'spot', start_date: 0, end_date: 10, initial_cash: 1000,
    });

    expect(result.finalState.margin).toBe(50);
    expect(result.finalState.liquidated).toBe(true);
    expect(result.finalState.position.qty).toBe(0);
  });

  test('throws on bad timestamps', async () => {
    const engine = new BacktestEngine();
    engine.setAdapter(adapterWith([{ type: 'candle', timestamp: 'not-a-time', close: 100 }]));
    engine.setStrategy(noopStrategy());

    await expect(engine.run({
      symbol: 'BTC/USDT', timeframe: '1m', market_type: 'spot', start_date: 0, end_date: 10, initial_cash: 1000,
    })).rejects.toThrow('Invalid timestamp');
  });
});
