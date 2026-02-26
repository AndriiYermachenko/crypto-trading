'use strict';

const { BacktestEngine } = require('../../engine');

class StaticAdapter {
  constructor(events) {
    this.events = events;
  }

  async load() {
    return this.events;
  }
}

class LongOnFirstTickStrategy {
  constructor() {
    this.sent = false;
  }

  onEvent(event) {
    if (event.type === 'tick' && !this.sent) {
      this.sent = true;
      return {
        type: 'signal_generated',
        timestamp: event.timestamp,
        side: 'buy',
        qty: 1,
        price: event.price,
      };
    }
    return [];
  }
}

const immediateExecution = {
  onSignal(signal) {
    return [
      {
        type: 'order_submitted',
        timestamp: signal.timestamp,
        order_id: 'o-1',
        side: signal.side,
        qty: signal.qty,
        price: signal.price,
      },
      {
        type: 'order_filled',
        timestamp: signal.timestamp,
        order_id: 'o-1',
        side: signal.side,
        qty: signal.qty,
        price: signal.price,
      },
    ];
  },
  onMarketEvent() {
    return [];
  },
};

describe('engine margin and funding flow', () => {
  test('uses mark price for unrealized pnl and emits margin updates', async () => {
    const engine = new BacktestEngine({ execution: immediateExecution });
    engine.setAdapter(new StaticAdapter([
      { type: 'tick', timestamp: 1, price: 100, mark_price: 100 },
      { type: 'tick', timestamp: 2, price: 90, mark_price: 80 },
    ]));
    engine.setStrategy(new LongOnFirstTickStrategy());

    const result = await engine.run({
      symbol: 'BTCUSDT',
      timeframe: '1m',
      market_type: 'futures',
      start_date: 1,
      end_date: 2,
      initial_cash: 1000,
      initial_margin_rate: 0.1,
      maintenance_margin_rate: 0.05,
    });

    const marginLogs = result.tradeLogs.filter((log) => log.type === 'margin_update');
    expect(marginLogs.length).toBeGreaterThan(0);
    expect(result.finalState.unrealizedPnl).toBe(-20);
    expect(result.finalState.equity).toBe(880);
  });

  test('creates funding payments as separate cash flows', async () => {
    const engine = new BacktestEngine({ execution: immediateExecution });
    engine.setAdapter(new StaticAdapter([
      { type: 'tick', timestamp: 0, price: 100, mark_price: 100 },
      { type: 'tick', timestamp: 10, price: 100, mark_price: 100 },
      { type: 'tick', timestamp: 20, price: 100, mark_price: 100 },
    ]));
    engine.setStrategy(new LongOnFirstTickStrategy());

    const result = await engine.run({
      symbol: 'BTCUSDT',
      timeframe: '1m',
      market_type: 'perpetual',
      start_date: 0,
      end_date: 20,
      initial_cash: 1000,
      funding_rate: 0.01,
      funding_interval_ms: 10,
    });

    const fundingLogs = result.tradeLogs.filter((log) => log.type === 'funding_payment');
    expect(fundingLogs).toHaveLength(2);
    expect(fundingLogs[0].amount).toBeCloseTo(-1);
  });

  test('liquidates when equity breaches maintenance margin threshold', async () => {
    const engine = new BacktestEngine({ execution: immediateExecution });
    engine.setAdapter(new StaticAdapter([
      { type: 'tick', timestamp: 1, price: 100, mark_price: 100 },
      { type: 'tick', timestamp: 2, price: 40, mark_price: 40 },
    ]));
    engine.setStrategy(new LongOnFirstTickStrategy());

    const result = await engine.run({
      symbol: 'BTCUSDT',
      timeframe: '1m',
      market_type: 'futures',
      start_date: 1,
      end_date: 2,
      initial_cash: 2,
      maintenance_margin_rate: 0.1,
      liquidation_penalty_rate: 0.05,
    });

    expect(result.finalState.liquidated).toBe(true);
    expect(result.finalState.position.qty).toBe(0);
    const liquidationLog = result.tradeLogs.find((log) => log.type === 'liquidated');
    expect(liquidationLog.penalty).toBeGreaterThan(0);
  });
});
