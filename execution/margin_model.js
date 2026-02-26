'use strict';

function calculateUnrealizedPnl(position = {}, markPrice) {
  const qty = Number(position.qty) || 0;
  const avgPrice = Number(position.avgPrice) || 0;
  const safeMark = Number.isFinite(markPrice) ? markPrice : avgPrice;
  return qty * (safeMark - avgPrice);
}

function calculateMarginSnapshot({
  position = {},
  markPrice,
  initialMarginRate = 0,
  maintenanceMarginRate = 0,
}) {
  const qty = Number(position.qty) || 0;
  const absQty = Math.abs(qty);
  const avgPrice = Number(position.avgPrice) || 0;
  const safeMark = Number.isFinite(markPrice) ? markPrice : avgPrice;

  const positionNotional = absQty * Math.abs(safeMark);
  const initialMargin = positionNotional * Math.max(0, initialMarginRate);
  const maintenanceMargin = positionNotional * Math.max(0, maintenanceMarginRate);
  const unrealizedPnl = calculateUnrealizedPnl(position, safeMark);

  return {
    markPrice: safeMark,
    positionNotional,
    initialMargin,
    maintenanceMargin,
    unrealizedPnl,
  };
}

module.exports = {
  calculateUnrealizedPnl,
  calculateMarginSnapshot,
};
