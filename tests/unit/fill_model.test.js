'use strict';

const { FillModel, roundToTick, roundToLot, slippageImpact } = require('../../execution/fill_model');

describe('fill model: bookless and orderbook', () => {
  test('fills from orderbook and falls back to bookless for remaining qty', () => {
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
    expect(result.fills[0]).toMatchObject({ qty: 1, price: 100, liquidity: 'taker' });
    expect(result.fills[1]).toMatchObject({ qty: 2, price: 102, liquidity: 'taker' });
  });

  test('bookless path handles zero spread/volume safely', () => {
    const model = new FillModel({ takerFeeRate: 0 });
    const result = model.executeMarketOrder({
      side: 'sell',
      qty: 1,
      timestamp: 1,
      market: { lastPrice: 50, spread: 0, avgVolume: 0 },
      slippageModel: { type: 'liquidity_based', base: 0.1, k: 1 },
    });

    expect(result.status).toBe('filled');
    expect(result.fills[0].price).toBeCloseTo(48.9);
  });
});

describe('fees/slippage and rounding constraints', () => {
  test('slippage variants and fees are applied', () => {
    expect(slippageImpact({ model: { type: 'pct_of_spread', pct: 0.5 }, side: 'buy', spread: 2, qty: 1, avgVolume: 1 })).toBe(1);

    const model = new FillModel({ stepSize: 1, takerFeeRate: 0.001 });
    const result = model.executeMarketOrder({ side: 'buy', qty: 2, timestamp: 1, market: { lastPrice: 100 } });

    expect(result.fills[0].fee).toBeCloseTo(0.2);
  });

  test('rounding helpers and minNotional validation', () => {
    expect(roundToTick(100.03, 0.05)).toBeCloseTo(100.05);
    expect(roundToLot(1.234, 0.01)).toBeCloseTo(1.23);

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
