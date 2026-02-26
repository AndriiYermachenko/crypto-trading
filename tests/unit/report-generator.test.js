'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { generateReport } = require('../../reports/generator');

describe('reports/generator', () => {
  test('builds trade journal, summary, diagnostics and exports files', () => {
    const t0 = Date.UTC(2024, 0, 1, 0, 0, 0);
    const t1 = t0 + 60_000;
    const t2 = t1 + 60_000;
    const t3 = t2 + 60_000;

    const tradeLogs = [
      { type: 'order_submitted', timestamp: t0, order_id: '1', side: 'buy', qty: 1, price: 100 },
      { type: 'order_filled', timestamp: t0, order_id: '1', side: 'buy', qty: 1, price: 101 },
      { type: 'order_submitted', timestamp: t1, order_id: '2', side: 'sell', qty: 1, price: 104 },
      { type: 'order_filled', timestamp: t1, order_id: '2', side: 'sell', qty: 1, price: 103.5 },
      { type: 'order_submitted', timestamp: t2, order_id: '3', side: 'buy', qty: 1, price: 99 },
      { type: 'order_cancelled', timestamp: t3, order_id: '3', reason: 'liquidity rejection' },
      { type: 'order_filled', timestamp: t3, order_id: 'orphan', side: 'buy', qty: 0.2, price: 105 },
    ];

    const equitySeries = [
      { timestamp: t0, equity: 1000, cash: 900, margin: 0, position_qty: 1, position_avg_price: 101 },
      { timestamp: t1, equity: 1010, cash: 1003.5, margin: 0, position_qty: 0, position_avg_price: 0 },
      { timestamp: t2, equity: 1008, cash: 1003.5, margin: 0, position_qty: 0, position_avg_price: 0 },
      { timestamp: t3, equity: 1012, cash: 982.5, margin: 0, position_qty: 0.2, position_avg_price: 105 },
    ];

    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-generator-'));

    const report = generateReport({ tradeLogs, equitySeries, initialCapital: 1000 }, { outputDir });

    expect(report.trades).toHaveLength(1);
    expect(report.summary.trade_count).toBe(1);
    expect(report.summary.net_pnl).toBeCloseTo(2.5, 5);

    expect(report.diagnostics.liquidityRejections).toHaveLength(1);
    expect(report.diagnostics.orphanedFills).toHaveLength(1);

    expect(fs.existsSync(path.join(outputDir, 'trades.csv'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'summary.json'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'equity.csv'))).toBe(true);
  });
});
