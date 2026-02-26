'use strict';

const { calculateUnrealizedPnl, calculateMarginSnapshot } = require('../../execution/margin_model');

describe('margin model', () => {
  test('calculates unrealized pnl for long and short positions', () => {
    expect(calculateUnrealizedPnl({ qty: 2, avgPrice: 100 }, 110)).toBe(20);
    expect(calculateUnrealizedPnl({ qty: -2, avgPrice: 100 }, 110)).toBe(-20);
  });

  test('returns initial and maintenance margin snapshot', () => {
    const snapshot = calculateMarginSnapshot({
      position: { qty: 3, avgPrice: 100 },
      markPrice: 90,
      initialMarginRate: 0.1,
      maintenanceMarginRate: 0.05,
    });

    expect(snapshot.positionNotional).toBe(270);
    expect(snapshot.initialMargin).toBe(27);
    expect(snapshot.maintenanceMargin).toBe(13.5);
    expect(snapshot.unrealizedPnl).toBe(-30);
  });
});
