'use strict';

const { calculateMarginSnapshot, calculateUnrealizedPnl } = require('../execution/margin_model');

const EVENT_PRIORITY = Object.freeze({
  tick: 10,
  candle: 10,
  signal_generated: 20,
  order_submitted: 30,
  order_filled: 40,
  order_cancelled: 50,
  funding_payment: 60,
  margin_update: 70,
  liquidated: 80,
});

const VALID_MARKET_TYPES = new Set(['spot', 'futures', 'perpetual']);

class BacktestEngine {
  constructor(options = {}) {
    this.randomSeed = options.random_seed ?? 1;
    this._rng = createSeededRng(this.randomSeed);

    this.reset();

    this._adapter = null;
    this._strategy = null;
    this._execution = options.execution ?? createDefaultExecution();
  }

  reset() {
    this.state = {
      cash: 0,
      equity: 0,
      margin: 0,
      maintenanceMargin: 0,
      unrealizedPnl: 0,
      lastPrice: null,
      markPrice: null,
      position: {
        qty: 0,
        avgPrice: 0,
      },
      liquidated: false,
    };

    this._eventQueue = [];
    this._seq = 0;
    this._tradeLogs = [];
    this._equitySeries = [];
    this._orders = new Map();
    this._currentConfig = null;
    this._nextFundingTimestamp = null;
  }

  setAdapter(adapter) {
    if (!adapter || typeof adapter.load !== 'function') {
      throw new Error('adapter must implement load(params)');
    }
    this._adapter = adapter;
    return this;
  }

  setStrategy(strategy) {
    if (!strategy || typeof strategy.onEvent !== 'function') {
      throw new Error('strategy must implement onEvent(event, ctx)');
    }
    this._strategy = strategy;
    return this;
  }

  setExecution(execution) {
    const requiredMethods = ['onSignal', 'onMarketEvent'];
    for (const method of requiredMethods) {
      if (!execution || typeof execution[method] !== 'function') {
        throw new Error(`execution must implement ${method}(...)`);
      }
    }
    this._execution = execution;
    return this;
  }

  async loadData(params) {
    if (!this._adapter) {
      throw new Error('adapter is not configured; call setAdapter(adapter)');
    }

    validateRunParams(params);
    const events = await this._adapter.load(params);
    if (!Array.isArray(events)) {
      throw new Error('adapter.load(params) must return an array of events');
    }

    return events.map((event) => normalizeEvent(event));
  }

  async run(params) {
    validateRunParams(params);
    if (!this._strategy) {
      throw new Error('strategy is not configured; call setStrategy(strategy)');
    }

    this.reset();
    this._currentConfig = { ...params };

    if (params.initial_cash != null) {
      this.state.cash = params.initial_cash;
      this.state.equity = params.initial_cash;
    }

    if (params.random_seed != null) {
      this.randomSeed = params.random_seed;
      this._rng = createSeededRng(this.randomSeed);
    }

    const events = await this.loadData(params);
    this.enqueueEvents(events);

    while (this._eventQueue.length > 0) {
      const nextEvent = this._eventQueue.shift();
      this.processEvent(nextEvent);

      if (this.state.liquidated) {
        break;
      }
    }

    return {
      tradeLogs: this.getTradeLogs(),
      equitySeries: this.getEquitySeries(),
      finalState: JSON.parse(JSON.stringify(this.state)),
    };
  }

  enqueueEvents(events) {
    for (const event of events) {
      const normalizedEvent = normalizeEvent(event);
      normalizedEvent._seq = this._seq++;
      this._eventQueue.push(normalizedEvent);
    }
    this._eventQueue.sort(compareEvents);
  }

  processEvent(event) {
    switch (event.type) {
      case 'tick':
      case 'candle':
        this.handleMarketEvent(event);
        break;
      case 'signal_generated':
        this.handleSignal(event);
        break;
      case 'order_submitted':
        this.handleOrderSubmitted(event);
        break;
      case 'order_filled':
        this.handleOrderFilled(event);
        break;
      case 'order_cancelled':
        this.handleOrderCancelled(event);
        break;
      case 'funding_payment':
        this.handleFundingPayment(event);
        break;
      case 'margin_update':
        this.handleMarginUpdate(event);
        break;
      case 'liquidated':
        this.handleLiquidation(event);
        break;
      default:
        throw new Error(`Unknown event type: ${event.type}`);
    }

    this.updateEquity(event.timestamp);
  }

  handleMarketEvent(event) {
    this.state.lastPrice = event.price ?? event.close ?? this.state.lastPrice;
    this.state.markPrice = event.mark_price ?? event.markPrice ?? this.state.markPrice ?? this.state.lastPrice;

    const strategyEvents = toArray(
      this._strategy.onEvent(event, this.createContext(event.timestamp)),
    );
    this.enqueueEvents(strategyEvents);

    const executionEvents = toArray(
      this._execution.onMarketEvent(event, this.createContext(event.timestamp)),
    );
    this.enqueueEvents(executionEvents);

    this.queueFundingEventsUntil(event.timestamp);
    this.queueRiskEvents(event.timestamp, { trigger: 'market' });
  }

  handleSignal(event) {
    const executionEvents = toArray(
      this._execution.onSignal(event, this.createContext(event.timestamp)),
    );
    this.enqueueEvents(executionEvents);
  }

  handleOrderSubmitted(event) {
    this._orders.set(event.order_id, { ...event, status: 'submitted' });
    this._tradeLogs.push({
      timestamp: event.timestamp,
      type: event.type,
      order_id: event.order_id,
      side: event.side,
      qty: event.qty,
      price: event.price,
    });
  }

  handleOrderFilled(event) {
    const fillPrice = event.price ?? this.state.lastPrice;
    const signedQty = event.side === 'sell' ? -Math.abs(event.qty) : Math.abs(event.qty);
    const value = signedQty * fillPrice;

    const prevQty = this.state.position.qty;
    const newQty = prevQty + signedQty;

    this.state.cash -= value;

    if (newQty === 0) {
      this.state.position.avgPrice = 0;
    } else if (Math.sign(prevQty) === Math.sign(newQty) || prevQty === 0) {
      const totalCost = this.state.position.avgPrice * prevQty + fillPrice * signedQty;
      this.state.position.avgPrice = totalCost / newQty;
    } else if (Math.sign(prevQty) !== Math.sign(newQty)) {
      this.state.position.avgPrice = fillPrice;
    }

    this.state.position.qty = newQty;

    this._orders.set(event.order_id, { ...event, status: 'filled' });
    this._tradeLogs.push({
      timestamp: event.timestamp,
      type: event.type,
      order_id: event.order_id,
      side: event.side,
      qty: event.qty,
      price: fillPrice,
      cash_after: this.state.cash,
      position_after: { ...this.state.position },
    });

    this.queueRiskEvents(event.timestamp, { trigger: 'fill' });
  }

  handleOrderCancelled(event) {
    if (this._orders.has(event.order_id)) {
      this._orders.set(event.order_id, { ...this._orders.get(event.order_id), status: 'cancelled' });
    }
    this._tradeLogs.push({
      timestamp: event.timestamp,
      type: event.type,
      order_id: event.order_id,
      reason: event.reason,
    });
  }

  handleFundingPayment(event) {
    this.state.cash += event.amount;
    this._tradeLogs.push({
      timestamp: event.timestamp,
      type: event.type,
      amount: event.amount,
      funding_rate: event.funding_rate,
      interval_multiplier: event.interval_multiplier,
    });

    this.queueRiskEvents(event.timestamp, { trigger: 'funding' });
  }

  handleMarginUpdate(event) {
    this.state.margin = event.initial_margin ?? event.margin ?? event.amount ?? this.state.margin;
    this.state.maintenanceMargin = event.maintenance_margin ?? this.state.maintenanceMargin;
    this.state.unrealizedPnl = event.unrealized_pnl ?? this.state.unrealizedPnl;
    this._tradeLogs.push({
      timestamp: event.timestamp,
      type: event.type,
      margin: this.state.margin,
      initial_margin: this.state.margin,
      maintenance_margin: this.state.maintenanceMargin,
      unrealized_pnl: this.state.unrealizedPnl,
      mark_price: event.mark_price,
      trigger: event.trigger,
    });
  }

  handleLiquidation(event) {
    this.state.liquidated = true;

    if (this.state.position.qty !== 0) {
      const closeSide = this.state.position.qty > 0 ? 'sell' : 'buy';
      const liquidationPrice = event.price ?? this.state.lastPrice ?? this.state.position.avgPrice;
      this.handleOrderFilled({
        ...event,
        type: 'order_filled',
        side: closeSide,
        qty: Math.abs(this.state.position.qty),
        price: liquidationPrice,
        order_id: event.order_id ?? `liq-${event.timestamp}`,
      });
    }

    if (event.penalty) {
      this.state.cash -= Math.abs(event.penalty);
    }

    this._tradeLogs.push({
      timestamp: event.timestamp,
      type: event.type,
      reason: event.reason,
      penalty: event.penalty ?? 0,
    });
  }

  updateEquity(timestamp) {
    const markPrice = this.getRiskPrice();
    const unrealizedPnl = calculateUnrealizedPnl(this.state.position, markPrice);
    this.state.equity = this.state.cash + unrealizedPnl;
    this.state.unrealizedPnl = unrealizedPnl;

    this._equitySeries.push({
      timestamp,
      equity: this.state.equity,
      cash: this.state.cash,
      margin: this.state.margin,
      maintenance_margin: this.state.maintenanceMargin,
      position_qty: this.state.position.qty,
      position_avg_price: this.state.position.avgPrice,
      last_price: this.state.lastPrice,
      mark_price: markPrice,
    });
  }

  queueFundingEventsUntil(timestamp) {
    const cfg = this._currentConfig ?? {};
    const fundingRate = Number(cfg.funding_rate) || 0;
    const intervalMs = Number(cfg.funding_interval_ms) || 0;

    if (fundingRate === 0 || intervalMs <= 0 || this.state.position.qty === 0) {
      return;
    }

    if (this._nextFundingTimestamp == null) {
      this._nextFundingTimestamp = timestamp + intervalMs;
      return;
    }

    while (this._nextFundingTimestamp <= timestamp) {
      const markPrice = this.getRiskPrice();
      const notional = Math.abs(this.state.position.qty) * Math.abs(markPrice);
      const amount = -notional * fundingRate;
      this.enqueueEvents([{ 
        type: 'funding_payment',
        timestamp: this._nextFundingTimestamp,
        amount,
        funding_rate: fundingRate,
        interval_multiplier: 1,
        position_notional: notional,
      }]);
      this._nextFundingTimestamp += intervalMs;
    }
  }

  queueRiskEvents(timestamp, { trigger } = {}) {
    const cfg = this._currentConfig ?? {};
    if (!isMarginMarket(cfg.market_type)) {
      return;
    }

    const snapshot = calculateMarginSnapshot({
      position: this.state.position,
      markPrice: this.getRiskPrice(),
      initialMarginRate: Number(cfg.initial_margin_rate) || 0,
      maintenanceMarginRate: Number(cfg.maintenance_margin_rate) || 0,
    });

    this.enqueueEvents([{
      type: 'margin_update',
      timestamp,
      initial_margin: snapshot.initialMargin,
      maintenance_margin: snapshot.maintenanceMargin,
      unrealized_pnl: snapshot.unrealizedPnl,
      mark_price: snapshot.markPrice,
      trigger,
    }]);

    const projectedEquity = this.state.cash + snapshot.unrealizedPnl;
    if (Math.abs(this.state.position.qty) > 0 && projectedEquity < snapshot.maintenanceMargin) {
      const penaltyRate = Math.max(0, Number(cfg.liquidation_penalty_rate) || 0);
      const penalty = snapshot.positionNotional * penaltyRate;
      this.enqueueEvents([{
        type: 'liquidated',
        timestamp,
        reason: 'maintenance_margin_breach',
        price: snapshot.markPrice,
        penalty,
      }]);
    }
  }

  getRiskPrice() {
    if (isMarginMarket(this._currentConfig?.market_type)) {
      return this.state.markPrice ?? this.state.lastPrice ?? this.state.position.avgPrice;
    }
    return this.state.lastPrice ?? this.state.position.avgPrice;
  }

  createContext(timestamp) {
    return {
      state: this.state,
      config: this._currentConfig,
      timestamp,
      markPrice: this.getRiskPrice(),
      random: () => this._rng(),
      queueEvent: (event) => this.enqueueEvents([event]),
    };
  }

  getTradeLogs() {
    return this._tradeLogs.map((entry) => ({ ...entry }));
  }

  getEquitySeries() {
    return this._equitySeries.map((entry) => ({ ...entry }));
  }
}

function validateRunParams(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('run params must be an object');
  }

  const requiredStringFields = ['symbol', 'timeframe', 'market_type'];
  for (const field of requiredStringFields) {
    if (typeof params[field] !== 'string' || params[field].trim() === '') {
      throw new Error(`${field} is required and must be a non-empty string`);
    }
  }

  if (!VALID_MARKET_TYPES.has(params.market_type)) {
    throw new Error(`market_type must be one of: ${Array.from(VALID_MARKET_TYPES).join(', ')}`);
  }

  if (params.start_date == null || params.end_date == null) {
    throw new Error('start_date and end_date are required');
  }

  const start = new Date(params.start_date).getTime();
  const end = new Date(params.end_date).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error('start_date and end_date must be valid date values');
  }

  if (start > end) {
    throw new Error('start_date must be less than or equal to end_date');
  }

  if (params.initial_cash != null && (!Number.isFinite(params.initial_cash) || params.initial_cash < 0)) {
    throw new Error('initial_cash must be a non-negative number');
  }

  if (params.random_seed != null && !Number.isInteger(params.random_seed)) {
    throw new Error('random_seed must be an integer');
  }
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new Error('each event must be an object');
  }

  if (!event.type || typeof event.type !== 'string') {
    throw new Error('each event must include string "type"');
  }

  if (event.timestamp == null) {
    throw new Error('each event must include timestamp');
  }

  const timestamp = normalizeTimestamp(event.timestamp);

  return {
    ...event,
    timestamp,
    priority: EVENT_PRIORITY[event.type] ?? 90,
  };
}

function normalizeTimestamp(timestamp) {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return timestamp;
  }

  const parsed = new Date(timestamp).getTime();
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid timestamp: ${timestamp}`);
  }

  return parsed;
}

function compareEvents(a, b) {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  return (a._seq ?? 0) - (b._seq ?? 0);
}

function toArray(value) {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function isMarginMarket(marketType) {
  return marketType === 'futures' || marketType === 'perpetual';
}

function createSeededRng(seed) {
  let state = hashSeed(seed) || 0x9e3779b9;

  return function random() {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed) {
  const stringValue = String(seed);
  let h = 2166136261;

  for (let i = 0; i < stringValue.length; i += 1) {
    h ^= stringValue.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return h >>> 0;
}

function createDefaultExecution() {
  let orderCounter = 0;

  return {
    onSignal(signal, ctx) {
      if (!signal || !signal.side || !signal.qty) {
        return [];
      }

      const orderId = `order-${++orderCounter}`;
      const latencyMs = Math.floor(ctx.random() * 100);
      const slippageBps = (ctx.random() - 0.5) * 10;
      const refPrice = signal.price ?? ctx.state.lastPrice ?? 0;
      const fillPrice = refPrice * (1 + slippageBps / 10000);

      const baseTimestamp = normalizeTimestamp(signal.timestamp ?? ctx.timestamp);

      return [
        {
          type: 'order_submitted',
          timestamp: baseTimestamp,
          order_id: orderId,
          side: signal.side,
          qty: signal.qty,
          price: refPrice,
        },
        {
          type: 'order_filled',
          timestamp: baseTimestamp + latencyMs,
          order_id: orderId,
          side: signal.side,
          qty: signal.qty,
          price: fillPrice,
        },
      ];
    },

    onMarketEvent() {
      return [];
    },
  };
}

module.exports = {
  BacktestEngine,
  EVENT_PRIORITY,
  validateRunParams,
  createSeededRng,
};
