import assert from 'assert';
import {
  calculateCommission,
  calculateProfitLoss,
  calculateLiquidity,
  calculateVolatility
} from '../src/utils/calculations.js';

export async function testCalculateCommission() {
  assert.strictEqual(calculateCommission(1000, 0.1), 1);
  assert.strictEqual(calculateCommission(0, 0.1), 0);
}

export async function testCalculateProfitLoss() {
  const result = calculateProfitLoss({
    entryPrice: 10,
    exitPrice: 12,
    quantity: 5,
    entryCommission: 0.1,
    exitCommission: 0.1
  });
  assert.strictEqual(result.usdt.toFixed(2), '9.80'); // (12*5-0.1)-(10*5+0.1)=9.8
  assert.strictEqual(result.percent.toFixed(2), '19.60');
}

export async function testCalculateLiquidity() {
  const orderBook = {
    asks: [
      ['1', '3'],
      ['1.1', '3']
    ]
  };
  const liq = calculateLiquidity(orderBook, 5); // need 5 usdt
  assert.strictEqual(liq.totalLiquidity.toFixed(2), '5.00');
  assert(liq.priceImpact > 0);
}

export async function testCalculateVolatility() {
  const klines = [
    [0,0,0,0,'10'],
    [0,0,0,0,'11'],
    [0,0,0,0,'12']
  ];
  const vol = calculateVolatility(klines);
  assert(vol > 0);
}
