'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { CsvAdapter } = require('../../../data/adapters/csv_adapter');

describe('CsvAdapter', () => {
  test('loads candle data from CSV and drops duplicates', async () => {
    const tmpFile = path.join(os.tmpdir(), `candles-${Date.now()}.csv`);
    await fs.writeFile(
      tmpFile,
      [
        'timestamp,open,high,low,close,volume',
        '2024-01-01T00:00:00Z,100,105,99,101,10',
        '2024-01-01T00:00:00Z,100,105,99,101,10',
        '2024-01-01T00:01:00Z,101,106,100,105,11',
      ].join('\n'),
    );

    const adapter = new CsvAdapter({ missing_data_policy: 'drop' });
    const events = await adapter.load({ data_path: tmpFile, timeframe: '1m' });

    expect(events).toHaveLength(2);
    expect(events[0].timestamp).toBe(new Date('2024-01-01T00:00:00Z').getTime());
  });

  test('interpolates missing candles when configured', async () => {
    const tmpFile = path.join(os.tmpdir(), `candles-gaps-${Date.now()}.json`);
    await fs.writeFile(
      tmpFile,
      JSON.stringify([
        { timestamp: '2024-01-01T00:00:00Z', open: 100, high: 102, low: 99, close: 101, volume: 10 },
        { timestamp: '2024-01-01T00:02:00Z', open: 104, high: 106, low: 103, close: 105, volume: 12 },
      ]),
    );

    const adapter = new CsvAdapter({ missing_data_policy: 'interpolate' });
    const events = await adapter.load({ data_path: tmpFile, timeframe: '1m' });

    expect(events).toHaveLength(3);
    expect(events[1].timestamp).toBe(new Date('2024-01-01T00:01:00Z').getTime());
  });

  test('rejects gaps when missing_data_policy=reject', async () => {
    const tmpFile = path.join(os.tmpdir(), `candles-reject-${Date.now()}.json`);
    await fs.writeFile(
      tmpFile,
      JSON.stringify([
        { timestamp: '2024-01-01T00:00:00Z', open: 100, high: 101, low: 99, close: 100, volume: 1 },
        { timestamp: '2024-01-01T00:03:00Z', open: 100, high: 101, low: 99, close: 100, volume: 1 },
      ]),
    );

    const adapter = new CsvAdapter({ missing_data_policy: 'reject' });
    await expect(adapter.load({ data_path: tmpFile, timeframe: '1m' })).rejects.toThrow('Missing candle data gap detected');
  });
});
