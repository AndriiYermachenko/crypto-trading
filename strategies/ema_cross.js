'use strict';

function calcEma(prev, price, period) {
  const alpha = 2 / (period + 1);
  if (prev == null) {
    return price;
  }
  return (price * alpha) + (prev * (1 - alpha));
}

class EmaCrossStrategy {
  constructor(options = {}) {
    this.shortPeriod = Number(options.short_period ?? 9);
    this.longPeriod = Number(options.long_period ?? 21);
    this.stopLossPct = Number(options.stop_loss_pct ?? 0);
    this.takeProfitPct = Number(options.take_profit_pct ?? 0);
    this.sizing = options.sizing || { mode: 'fixed_amount', amount: 1 };

    if (!Number.isFinite(this.shortPeriod) || !Number.isFinite(this.longPeriod) || this.shortPeriod <= 0 || this.longPeriod <= 0 || this.shortPeriod >= this.longPeriod) {
      throw new Error('EMA periods must be positive and short_period < long_period');
    }

    this.fast = null;
    this.slow = null;
    this.prevFast = null;
    this.prevSlow = null;
    this.lastSignal = 0;
  }

  _sizeForPrice(price, ctx) {
    const equity = Number(ctx?.state?.equity ?? ctx?.state?.cash ?? 0);
    const cash = Number(ctx?.state?.cash ?? 0);
    const mode = this.sizing.mode || 'fixed_amount';

    if (mode === 'fixed_amount') {
      return Number(this.sizing.amount ?? 0);
    }

    if (mode === 'percent_equity') {
      const pct = Number(this.sizing.percent ?? 0);
      if (!Number.isFinite(price) || price <= 0) return 0;
      return (equity * pct) / price;
    }

    if (mode === 'risk_per_trade') {
      const riskPct = Number(this.sizing.risk_pct ?? 0);
      const stopPct = Number(this.stopLossPct);
      if (!Number.isFinite(price) || price <= 0 || stopPct <= 0) return 0;
      const riskBudget = Math.max(0, (cash || equity) * riskPct);
      const lossPerUnit = price * stopPct;
      return riskBudget / lossPerUnit;
    }

    return 0;
  }

  _stopTakeSignal(price, timestamp, ctx) {
    const pos = ctx.state.position;
    if (!pos || pos.qty === 0 || !Number.isFinite(pos.avgPrice)) {
      return null;
    }

    if (pos.qty > 0) {
      const stop = this.stopLossPct > 0 && price <= pos.avgPrice * (1 - this.stopLossPct);
      const take = this.takeProfitPct > 0 && price >= pos.avgPrice * (1 + this.takeProfitPct);
      if (stop || take) {
        return {
          type: 'signal_generated',
          timestamp,
          side: 'sell',
          qty: Math.abs(pos.qty),
          reason: stop ? 'stop_loss' : 'take_profit',
          price,
        };
      }
    } else if (pos.qty < 0) {
      const stop = this.stopLossPct > 0 && price >= pos.avgPrice * (1 + this.stopLossPct);
      const take = this.takeProfitPct > 0 && price <= pos.avgPrice * (1 - this.takeProfitPct);
      if (stop || take) {
        return {
          type: 'signal_generated',
          timestamp,
          side: 'buy',
          qty: Math.abs(pos.qty),
          reason: stop ? 'stop_loss' : 'take_profit',
          price,
        };
      }
    }

    return null;
  }

  onEvent(event, ctx) {
    if (!event || (event.type !== 'candle' && event.type !== 'tick')) {
      return [];
    }

    const price = Number(event.close ?? event.price);
    if (!Number.isFinite(price) || price <= 0) {
      return [];
    }

    const stopTake = this._stopTakeSignal(price, event.timestamp, ctx);
    if (stopTake) {
      return [stopTake];
    }

    this.prevFast = this.fast;
    this.prevSlow = this.slow;
    this.fast = calcEma(this.fast, price, this.shortPeriod);
    this.slow = calcEma(this.slow, price, this.longPeriod);

    if (this.prevFast == null || this.prevSlow == null) {
      return [];
    }

    const crossedUp = this.prevFast <= this.prevSlow && this.fast > this.slow;
    const crossedDown = this.prevFast >= this.prevSlow && this.fast < this.slow;

    if (!crossedUp && !crossedDown) {
      return [];
    }

    const direction = crossedUp ? 1 : -1;
    if (direction === this.lastSignal) {
      return [];
    }

    const size = this._sizeForPrice(price, ctx);
    if (!Number.isFinite(size) || size <= 0) {
      return [];
    }

    this.lastSignal = direction;
    return [{
      type: 'signal_generated',
      timestamp: event.timestamp,
      side: crossedUp ? 'buy' : 'sell',
      qty: size,
      reason: crossedUp ? 'ema_cross_up' : 'ema_cross_down',
      price,
    }];
  }
}

module.exports = {
  EmaCrossStrategy,
  calcEma,
};
