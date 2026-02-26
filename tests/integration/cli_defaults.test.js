'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

describe('run_backtest CLI defaults', () => {
  test('runs without --data by using bundled sample dataset', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-cli-defaults-'));
    const output = execFileSync('node', ['run_backtest.js', '--out-dir', outDir], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
    });

    expect(output).toContain('--data not provided, using bundled sample');
    const summaryPath = path.join(outDir, 'summary.json');
    const tradesPath = path.join(outDir, 'trades.csv');
    expect(fs.existsSync(summaryPath)).toBe(true);
    expect(fs.existsSync(tradesPath)).toBe(true);

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    expect(summary.strategy).toBe('ema_cross');
    expect(summary.from).toBeTruthy();
    expect(summary.to).toBeTruthy();
  });
});
