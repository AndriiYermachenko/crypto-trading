'use strict';

function roundToStep(value, step) {
  if (!Number.isFinite(step) || step <= 0) {
    return value;
  }
  const scaled = Math.round((value / step) + Number.EPSILON);
  return scaled * step;
}

function roundToTick(price, tickSize) {
  return roundToStep(price, tickSize);
}

function roundToLot(qty, stepSize) {
  return roundToStep(qty, stepSize);
}

function normalizeBookSide(levels) {
  if (!Array.isArray(levels)) {
    return [];
  }
  return levels
    .map((level) => ({ price: Number(level.price), qty: Number(level.qty) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.qty) && level.qty > 0)
    .sort((a, b) => a.price - b.price);
}

function slippageImpact({ model, side, spread, qty, avgVolume }) {
  const direction = side === 'buy' ? 1 : -1;
  if (!model || !model.type) {
    return 0;
  }

  switch (model.type) {
    case 'simple_fixed':
      return direction * (Number(model.fixed) || 0);
    case 'pct_of_spread':
      return direction * spread * (Number(model.pct) || 0);
    case 'liquidity_based': {
      const base = Number(model.base) || 0;
      const k = Number(model.k) || 0;
      const denom = Number(avgVolume) > 0 ? Number(avgVolume) : 1;
      return direction * (base + k * (Math.abs(qty) / denom));
    }
    default:
      return 0;
  }
}

class PositionLedger {
  constructor() {
    this.qty = 0;
    this.avgPrice = 0;
    this.realizedPnl = 0;
  }

  applyFill({ side, qty, price, fee = 0 }) {
    const signedQty = side === 'buy' ? Math.abs(qty) : -Math.abs(qty);
    const prevQty = this.qty;
    const prevAvg = this.avgPrice;

    let realizedDelta = -fee;

    if (prevQty === 0 || Math.sign(prevQty) === Math.sign(signedQty)) {
      const newQty = prevQty + signedQty;
      const weighted = (Math.abs(prevQty) * prevAvg) + (Math.abs(signedQty) * price);
      this.qty = newQty;
      this.avgPrice = newQty === 0 ? 0 : weighted / Math.abs(newQty);
      this.realizedPnl += realizedDelta;
      return realizedDelta;
    }

    const closingQty = Math.min(Math.abs(prevQty), Math.abs(signedQty));
    if (prevQty > 0) {
      realizedDelta += (price - prevAvg) * closingQty;
    } else {
      realizedDelta += (prevAvg - price) * closingQty;
    }

    const remaining = prevQty + signedQty;
    this.qty = remaining;

    if (remaining === 0) {
      this.avgPrice = 0;
    } else if (Math.sign(remaining) === Math.sign(prevQty)) {
      this.avgPrice = prevAvg;
    } else {
      this.avgPrice = price;
    }

    this.realizedPnl += realizedDelta;
    return realizedDelta;
  }
}

class FillModel {
  constructor(options = {}) {
    this.constraints = {
      tickSize: options.tickSize,
      stepSize: options.stepSize,
      minNotional: options.minNotional,
      minQty: options.minQty,
      maxQty: options.maxQty,
    };

    this.fees = {
      maker: Number(options.makerFeeRate ?? 0),
      taker: Number(options.takerFeeRate ?? 0),
    };

    this.defaultSlippageModel = options.slippageModel || { type: 'simple_fixed', fixed: 0 };
    this.defaultCancelLatencyMs = Number(options.cancelLatencyMs ?? 0);
    this.orderLatencyMs = Number(options.orderLatencyMs ?? 0);

    this.orders = new Map();
    this._id = 1;
    this.ledger = new PositionLedger();
  }

  _buildReject(reason, details = {}) {
    return { status: 'rejected', reason, ...details };
  }

  _validateOrder(qty, priceHint) {
    const roundedQty = roundToLot(qty, this.constraints.stepSize);
    if (!Number.isFinite(roundedQty) || roundedQty <= 0) {
      return this._buildReject('invalid_qty');
    }

    if (this.constraints.minQty != null && roundedQty < this.constraints.minQty) {
      return this._buildReject('min_qty_violation', { qty: roundedQty });
    }

    if (this.constraints.maxQty != null && roundedQty > this.constraints.maxQty) {
      return this._buildReject('max_qty_violation', { qty: roundedQty });
    }

    if (priceHint != null && this.constraints.minNotional != null) {
      const notional = roundedQty * priceHint;
      if (notional < this.constraints.minNotional) {
        return this._buildReject('min_notional_violation', { qty: roundedQty, notional });
      }
    }

    return { status: 'ok', roundedQty };
  }

  _bookFill({ side, qty, book, limitPrice, timestamp, orderId, forceTaker = true }) {
    const levels = side === 'buy'
      ? normalizeBookSide(book?.asks)
      : normalizeBookSide(book?.bids).sort((a, b) => b.price - a.price);

    let remaining = qty;
    const fills = [];

    for (const level of levels) {
      const priceMatch = side === 'buy'
        ? (limitPrice == null || level.price <= limitPrice)
        : (limitPrice == null || level.price >= limitPrice);
      if (!priceMatch || remaining <= 0) {
        continue;
      }

      const executedQty = Math.min(remaining, level.qty);
      const executedPrice = roundToTick(level.price, this.constraints.tickSize);
      const executedNotional = executedQty * executedPrice;
      const feeRate = forceTaker ? this.fees.taker : this.fees.maker;
      const fee = executedNotional * feeRate;
      const realizedPnlDelta = this.ledger.applyFill({ side, qty: executedQty, price: executedPrice, fee });

      fills.push({
        orderId,
        timestamp,
        side,
        qty: executedQty,
        price: executedPrice,
        executedNotional,
        fee,
        feeRate,
        liquidity: forceTaker ? 'taker' : 'maker',
        realizedPnlDelta,
      });

      remaining -= executedQty;
    }

    return { fills, remainingQty: remaining };
  }

  _booklessFill({ side, qty, market, orderId, timestamp, model }) {
    const refPrice = Number(market?.lastPrice ?? market?.midPrice ?? market?.price);
    if (!Number.isFinite(refPrice)) {
      return { fills: [], remainingQty: qty };
    }

    const spread = Number(market?.spread ?? 0);
    const avgVolume = Number(market?.avgVolume ?? qty);
    const slip = slippageImpact({
      model: model || this.defaultSlippageModel,
      side,
      spread,
      qty,
      avgVolume,
    });

    const executedPrice = roundToTick(refPrice + slip, this.constraints.tickSize);
    const executedNotional = executedPrice * qty;
    const fee = executedNotional * this.fees.taker;
    const realizedPnlDelta = this.ledger.applyFill({ side, qty, price: executedPrice, fee });

    return {
      fills: [{
        orderId,
        timestamp,
        side,
        qty,
        price: executedPrice,
        executedNotional,
        fee,
        feeRate: this.fees.taker,
        liquidity: 'taker',
        realizedPnlDelta,
      }],
      remainingQty: 0,
    };
  }

  executeMarketOrder({ side, qty, timestamp, orderId, orderbook, market, slippageModel }) {
    const validation = this._validateOrder(qty, market?.lastPrice ?? market?.midPrice ?? market?.price);
    if (validation.status !== 'ok') {
      return validation;
    }

    const id = orderId || `mkt-${this._id++}`;
    const roundedQty = validation.roundedQty;

    const bookResult = this._bookFill({
      side,
      qty: roundedQty,
      book: orderbook,
      timestamp,
      orderId: id,
      forceTaker: true,
    });

    let fills = [...bookResult.fills];
    let remaining = bookResult.remainingQty;

    if (remaining > 0) {
      const fallback = this._booklessFill({
        side,
        qty: remaining,
        market,
        orderId: id,
        timestamp,
        model: slippageModel,
      });
      fills = fills.concat(fallback.fills);
      remaining = fallback.remainingQty;
    }

    return {
      status: remaining === 0 ? 'filled' : 'partial',
      orderId: id,
      requestedQty: roundedQty,
      filledQty: roundedQty - remaining,
      remainingQty: remaining,
      fills,
    };
  }

  submitLimitOrder({ side, qty, price, mode = 'passive', ttlMs, timestamp, orderId }) {
    const roundedPrice = roundToTick(price, this.constraints.tickSize);
    const validation = this._validateOrder(qty, roundedPrice);
    if (validation.status !== 'ok') {
      return validation;
    }

    const id = orderId || `lmt-${this._id++}`;
    const order = {
      orderId: id,
      side,
      qty: validation.roundedQty,
      remainingQty: validation.roundedQty,
      price: roundedPrice,
      mode,
      status: 'open',
      createdAt: timestamp,
      activeAt: timestamp + this.orderLatencyMs,
      expiresAt: ttlMs != null ? timestamp + ttlMs : null,
      cancelRequestedAt: null,
      cancelEffectiveAt: null,
      fills: [],
    };

    this.orders.set(id, order);
    return { status: 'accepted', orderId: id, order };
  }

  requestCancel(orderId, timestamp, latencyMs = this.defaultCancelLatencyMs) {
    const order = this.orders.get(orderId);
    if (!order || order.status !== 'open') {
      return this._buildReject('order_not_open', { orderId });
    }

    order.cancelRequestedAt = timestamp;
    order.cancelEffectiveAt = timestamp + Math.max(0, Number(latencyMs) || 0);
    return { status: 'cancel_requested', orderId, effectiveAt: order.cancelEffectiveAt };
  }

  _executeLimitOrder(order, marketEvent) {
    const crossed = order.side === 'buy'
      ? Number(marketEvent.bestAsk) <= order.price
      : Number(marketEvent.bestBid) >= order.price;

    if (!crossed && order.mode === 'passive') {
      return [];
    }

    const book = marketEvent.orderbook || {
      asks: marketEvent.asks,
      bids: marketEvent.bids,
    };

    const result = this._bookFill({
      side: order.side,
      qty: order.remainingQty,
      book,
      limitPrice: order.price,
      timestamp: marketEvent.timestamp,
      orderId: order.orderId,
      forceTaker: order.mode === 'aggressive',
    });

    if (result.fills.length > 0) {
      order.fills.push(...result.fills);
      order.remainingQty = result.remainingQty;
      if (order.remainingQty <= 0) {
        order.status = 'filled';
      }
    }

    return result.fills;
  }

  processMarketEvent(marketEvent) {
    const fills = [];
    const cancellations = [];

    for (const order of this.orders.values()) {
      if (order.status !== 'open') {
        continue;
      }

      if (marketEvent.timestamp < order.activeAt) {
        continue;
      }

      if (order.cancelEffectiveAt != null && marketEvent.timestamp >= order.cancelEffectiveAt) {
        order.status = 'cancelled';
        cancellations.push({ orderId: order.orderId, reason: 'user_cancel', timestamp: marketEvent.timestamp });
        continue;
      }

      if (order.expiresAt != null && marketEvent.timestamp >= order.expiresAt) {
        order.status = 'cancelled';
        cancellations.push({ orderId: order.orderId, reason: 'ttl_timeout', timestamp: marketEvent.timestamp });
        continue;
      }

      fills.push(...this._executeLimitOrder(order, marketEvent));
    }

    return { fills, cancellations };
  }
}

module.exports = {
  FillModel,
  PositionLedger,
  roundToTick,
  roundToLot,
  slippageImpact,
};
