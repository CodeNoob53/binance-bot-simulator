// Utility calculation functions

/**
 * Calculate commission for a trade.
 * @param {number} amount - Trade amount in USDT or asset value.
 * @param {number} feePercent - Commission percentage (e.g. 0.075 for 0.075%).
 * @returns {number} Commission value.
 */
export function calculateCommission(amount, feePercent) {
  if (!amount || !feePercent) return 0;
  return amount * (feePercent / 100);
}

/**
 * Calculate profit and loss for a trade.
 * @param {Object} params
 * @param {number} params.entryPrice
 * @param {number} params.exitPrice
 * @param {number} params.quantity
 * @param {number} [params.entryCommission]
 * @param {number} [params.exitCommission]
 * @returns {{usdt:number, percent:number}}
 */
export function calculateProfitLoss({ entryPrice, exitPrice, quantity, entryCommission = 0, exitCommission = 0 }) {
  const entryCost = entryPrice * quantity + entryCommission;
  const exitValue = exitPrice * quantity - exitCommission;
  const profit = exitValue - entryCost;
  const percent = entryCost !== 0 ? (profit / (entryPrice * quantity)) * 100 : 0;
  return { usdt: profit, percent };
}

/**
 * Evaluate available liquidity and price impact for buying with given USDT amount.
 * Order book should have 'asks' array [[price, quantity], ...].
 * @param {Object} orderBook
 * @param {number} tradeAmountUsdt
 * @returns {{ totalLiquidity:number, priceImpact:number }}
 */
export function calculateLiquidity(orderBook, tradeAmountUsdt) {
  if (!orderBook || !Array.isArray(orderBook.asks)) {
    return { totalLiquidity: 0, priceImpact: 0 };
  }

  let remaining = tradeAmountUsdt;
  let cost = 0;
  let baseQty = 0;

  for (const [priceStr, qtyStr] of orderBook.asks) {
    const price = parseFloat(priceStr);
    const qty = parseFloat(qtyStr);
    const value = price * qty;

    if (remaining <= value) {
      const neededQty = remaining / price;
      cost += neededQty * price;
      baseQty += neededQty;
      remaining = 0;
      break;
    }

    cost += value;
    baseQty += qty;
    remaining -= value;
  }

  const totalLiquidity = tradeAmountUsdt - remaining;
  const averagePrice = baseQty > 0 ? cost / baseQty : 0;
  const bestPrice = orderBook.asks.length ? parseFloat(orderBook.asks[0][0]) : 0;
  const priceImpact = bestPrice > 0 ? ((averagePrice - bestPrice) / bestPrice) * 100 : 0;

  return { totalLiquidity, priceImpact };
}

/**
 * Calculate volatility of price data using standard deviation of percentage changes.
 * @param {Array} klines - Array of kline objects with close prices (kline[4] or {close}).
 * @returns {number} Volatility percentage.
 */
export function calculateVolatility(klines) {
  if (!Array.isArray(klines) || klines.length < 2) return 0;

  const closes = klines.map(k => Array.isArray(k) ? parseFloat(k[4]) : parseFloat(k.close));
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    changes.push((curr - prev) / prev);
  }

  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const variance = changes.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / changes.length;
  const stdDev = Math.sqrt(variance);

  return stdDev * 100;
}

export default {
  calculateCommission,
  calculateProfitLoss,
  calculateLiquidity,
  calculateVolatility
};
