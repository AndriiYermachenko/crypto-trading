'use strict';

jest.mock('axios', () => ({ get: jest.fn() }));

const axios = require('axios');
const { BinanceReplayAdapter } = require('../../../data/adapters/binance_replay_adapter');

describe('BinanceReplayAdapter', () => {
  test('returns normalized candle events from REST', async () => {
    axios.get.mockResolvedValueOnce({
      data: [
        [1704067200000, '100', '101', '99', '100.5', '10'],
        [1704067260000, '100.5', '102', '100', '101', '12'],
      ],
    });

    const adapter = new BinanceReplayAdapter({ useWebsocket: false });
    const events = await adapter.load({
      symbol: 'btcusdt',
      timeframe: '1m',
      start_date: '2024-01-01T00:00:00Z',
      end_date: '2024-01-01T00:02:00Z',
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'candle', source: 'binance_rest', open: 100, close: 100.5 });
    expect(axios.get).toHaveBeenCalled();
  });

  test('supports event iteration interface', async () => {
    axios.get.mockResolvedValueOnce({
      data: [[1704067200000, '1', '2', '0.5', '1.5', '100']],
    });

    const adapter = new BinanceReplayAdapter({ useWebsocket: false });
    const collected = [];
    for await (const event of adapter.iterateEvents({
      symbol: 'ethusdt',
      timeframe: '1m',
      start_date: 1704067200000,
      end_date: 1704067260000,
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].volume).toBe(100);
  });
});
