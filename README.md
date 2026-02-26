# crypto-trading

Минимальный backtesting-фреймворк для крипто-стратегий с CLI-запуском, моделью исполнения ордеров и тестами.

## Setup

```bash
npm i
npm test
```

## Backtest CLI (`run_backtest.js`)

Скрипт запускает backtest с конфигом, стратегией и датасетом свечей.

### Поддерживаемые аргументы

- `--strategy` (сейчас: `ema_cross`)
- `--symbol` (например `BTC/USDT`)
- `--from`, `--to` (ISO-время или unix ms)
- `--tf` (таймфрейм, например `1m`)
- `--initial` (initial cash)
- `--data` (путь к `.csv` или `.json` свечам)
- `--config` (путь к json-конфигу)
- `--out-dir` (директория для `summary.json` и `trades.csv`)
- EMA/риск-параметры:
  - `--ema-short`, `--ema-long`
  - `--stop`, `--take` (доли: `0.01 = 1%`)
  - `--sizing` (`fixed_amount`, `percent_equity`, `risk_per_trade`)
  - `--amount`, `--percent`, `--risk`
- `--random-seed`

### Примеры запуска

```bash
node run_backtest.js \
  --strategy ema_cross \
  --symbol BTC/USDT \
  --from 2024-01-01T00:00:00Z \
  --to 2024-01-03T00:00:00Z \
  --tf 1m \
  --initial 10000 \
  --data ./data/btc_1m.csv \
  --sizing fixed_amount \
  --amount 0.01
```

```bash
node run_backtest.js \
  --strategy ema_cross \
  --from 1704067200000 \
  --to 1704153600000 \
  --data ./data/btc_1m.csv \
  --sizing risk_per_trade \
  --risk 0.01 \
  --stop 0.005 \
  --take 0.01 \
  --random-seed 42
```

```bash
node run_backtest.js
```

Команда выше запустит backtest на встроенном демо-наборе `examples/data/sample_candles.csv` и автоматически определит `--from/--to` по данным.

## Формат входных данных

### CSV

Ожидается header и одна свеча на строку.

```csv
timestamp,open,high,low,close,volume
1704067200000,42500,42510,42490,42505,12.4
1704067260000,42505,42530,42500,42528,9.1
```

Допускаются timestamp-алиасы: `timestamp | ts | time`.

### JSON

Массив событий (обычно `candle`):

```json
[
  {"type":"candle","timestamp":1704067200000,"open":42500,"high":42510,"low":42490,"close":42505,"price":42505},
  {"type":"candle","timestamp":1704067260000,"open":42505,"high":42530,"low":42500,"close":42528,"price":42528}
]
```

## Пример выходных файлов

### `summary.json`

```json
{
  "symbol": "BTC/USDT",
  "timeframe": "1m",
  "from": "2024-01-01T00:00:00Z",
  "to": "2024-01-03T00:00:00Z",
  "strategy": "ema_cross",
  "trades": 14,
  "final_equity": 10142.44,
  "final_cash": 10001.12,
  "final_position_qty": 0.01,
  "liquidated": false
}
```

### `trades.csv`

```csv
timestamp,type,order_id,side,qty,price,cash_after,reason
1704067265000,order_submitted,order-1,buy,0.01,42528,,
1704067265082,order_filled,order-1,buy,0.01,42530.1,9574.699,
```

## Strategy: `strategies/ema_cross.js`

Реализовано:

- EMA short/long crossover (`short_period < long_period`)
- Exit по stop-loss / take-profit
- Sizing modes:
  - `fixed_amount`
  - `percent_equity`
  - `risk_per_trade` (через риск-бюджет и `stop_loss_pct`)

## Assumptions

- `run_backtest.js` ориентирован на offline replay свечей.
- Исполнение ордеров в движке по умолчанию моделируется простым latency/slippage RNG-процессом.
- Стратегия испускает `signal_generated`, а `execution` превращает сигнал в `order_submitted/order_filled`.
- Нет полного matching engine, funding schedule или mark-price model “как на бирже”.

## Real-world fidelity calibration

Для более реалистичных результатов рекомендуется:

1. **Slippage calibration**: подбирать `slippage model` по историческим microstructure-данным (spread + depth bins).
2. **Latency calibration**: использовать распределения задержек (p50/p95/p99), а не одну константу.
3. **Fees/rebates tiers**: учитывать maker/taker tiers и VIP-скидки по объему.
4. **Orderbook replay**: где возможно, заменять candle-only поток на L2/L3 replay.
5. **Liquidation/margin**: моделировать maintenance margin и liquidation buffer по правилам конкретной биржи.
6. **Clock/clock-skew**: учитывать задержку маркет-данных и рассинхронизацию timestamp между feed и executor.

