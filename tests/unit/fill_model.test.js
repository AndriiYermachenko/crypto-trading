'use strict';

const { FillModel, roundToTick, roundToLot, slippageImpact } = require('../../execution/fill_model');

describe('rounding helpers', () => {
  test('roundToTick and roundToLot', () => {
    expect(roundToTick(100.03, 0.05)).toBeCloseTo(100.05);
    expect(roundToLot(1.234, 0.01)).toBeCloseTo(1.23);
  });
});

describe('market execution', () => {
  test('fills from book and fallback slippage', () => {
    const model = new FillModel({ tickSize: 0.1, stepSize: 0.1, takerFeeRate: 0.001 });

    const result = model.executeMarketOrder({
      side: 'buy',
      qty: 3,
      timestamp: 1,
      orderbook: { asks: [{ price: 100, qty: 1 }], bids: [] },
      market: { lastPrice: 101, spread: 2, avgVolume: 10 },
      slippageModel: { type: 'simple_fixed', fixed: 1 },
    });

    expect(result.status).toBe('filled');
    expect(result.fills).toHaveLength(2);
    expect(result.fills[0].qty).toBe(1);
    expect(result.fills[1].price).toBeCloseTo(102);
  });

  test('rejects order by minNotional', () => {
    const model = new FillModel({ minNotional: 100, stepSize: 0.1 });
    const result = model.executeMarketOrder({
      side: 'buy',
      qty: 0.5,
      market: { lastPrice: 100 },
      timestamp: 1,
    });

    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('min_notional_violation');
  });
});

describe('limit orders', () => {
  test('passive partial fill with ttl timeout', () => {
    const model = new FillModel({ tickSize: 1, stepSize: 1, makerFeeRate: 0.0005 });

    const submit = model.submitLimitOrder({ side: 'buy', qty: 5, price: 100, ttlMs: 10, timestamp: 0, mode: 'passive', orderId: 'L1' });
    expect(submit.status).toBe('accepted');

    let eventResult = model.processMarketEvent({
      timestamp: 5,
      bestAsk: 100,
      bestBid: 99,
      orderbook: { asks: [{ price: 100, qty: 2 }], bids: [] },
    });

    expect(eventResult.fills).toHaveLength(1);
    expect(eventResult.fills[0].liquidity).toBe('maker');

    eventResult = model.processMarketEvent({ timestamp: 11, bestAsk: 101, bestBid: 100, orderbook: { asks: [], bids: [] } });
    expect(eventResult.cancellations).toHaveLength(1);
    expect(eventResult.cancellations[0].reason).toBe('ttl_timeout');
  });

  test('cancel respects latency and can fill before effective cancel', () => {
    const model = new FillModel({ tickSize: 1, stepSize: 1, cancelLatencyMs: 5 });
    model.submitLimitOrder({ side: 'sell', qty: 1, price: 100, timestamp: 0, mode: 'aggressive', orderId: 'L2' });
    model.requestCancel('L2', 10);

    let eventResult = model.processMarketEvent({
      timestamp: 12,
      bestAsk: 101,
      bestBid: 100,
      orderbook: { bids: [{ price: 100, qty: 1 }], asks: [] },
    });
    expect(eventResult.fills).toHaveLength(1);

    eventResult = model.processMarketEvent({ timestamp: 16, bestAsk: 101, bestBid: 99, orderbook: { bids: [], asks: [] } });
    expect(eventResult.cancellations).toHaveLength(0);
  });
});

describe('slippage models and pnl', () => {
  test('supports slippage variants and realized pnl on partial close', () => {
    expect(slippageImpact({ model: { type: 'pct_of_spread', pct: 0.5 }, side: 'buy', spread: 2, qty: 1, avgVolume: 1 })).toBe(1);
    expect(slippageImpact({ model: { type: 'liquidity_based', base: 0.1, k: 0.5 }, side: 'sell', spread: 0, qty: 2, avgVolume: 4 })).toBeCloseTo(-0.35);

    const model = new FillModel({ stepSize: 1, takerFeeRate: 0 });
    model.executeMarketOrder({ side: 'buy', qty: 2, timestamp: 1, market: { lastPrice: 100 } });
    const close = model.executeMarketOrder({ side: 'sell', qty: 1, timestamp: 2, market: { lastPrice: 110 } });

    expect(close.fills[0].realizedPnlDelta).toBe(10);
  });
});
