import assert from 'assert';
import { BaseStrategy } from '../src/simulation/strategies/baseStrategy.js';

export async function testExitPositionProfitCalculation() {
  const strategy = new BaseStrategy({ binanceFeePercent: 0.1 });
  const trade = {
    id: 't1',
    symbol: 'TST',
    entryTime: Date.now(),
    entryPrice: 10,
    quantity: 2,
    tpPrice: 11,
    slPrice: 9,
    status: 'active'
  };
  strategy.activeTrades.set(trade.id, trade);

  const { success, trade: closed } = await strategy.exitPosition(trade, 12, 'take_profit');
  assert.strictEqual(success, true);
  const expected = (12 - 10) * 2 - (10 * 2 * 0.1) - (12 * 2 * 0.1);
  assert(Math.abs(closed.profitLossUsdt - expected) < 1e-8);
}
