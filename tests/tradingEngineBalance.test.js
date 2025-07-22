import assert from 'assert';
import { TradingEngine } from '../src/simulation/tradingEngine.js';

export async function testTradeProfitMatchesBalance() {
  process.env.INITIAL_BALANCE_USDT = '10000';

  const config = {
    simulationMode: true,
    buyAmountUsdt: 100,
    binanceFeePercent: 0.1,
    takeProfitPercent: 0.1,
    stopLossPercent: 0.05
  };

  const apiClient = {
    order: async () => ({ success: true, orderId: '1', price: 0, quantity: 1 }),
    ping: async () => {},
    balance: async () => ({ balances: [] })
  };

  const engine = new TradingEngine(config, apiClient);

  // override order creation to bypass validation logic
  engine.createOrder = async () => ({
    success: true,
    orderId: '1',
    price: 0,
    quantity: 1
  });

  // stub exit condition generator
  engine.strategy.getExitConditions = (entryPrice, cfg) => ({
    trailingStopEnabled: false,
    takeProfitPrice: entryPrice * (1 + cfg.takeProfitPercent),
    stopLossPrice: entryPrice * (1 - cfg.stopLossPercent)
  });

  const marketData = {
    symbol: 'TSTUSDT',
    ticker: { price: '100', volume: '1000', priceChangePercent: '0' },
    orderBook: { bids: [['99', '1']], asks: [['101', '1']] },
    klines: [{ open: '100', high: '100', low: '100', close: '100', volume: '1000' }]
  };

  const result = await engine.executeBuy(marketData);
  assert(result.success);
  const trade = result.trade;

  // after buy, balance reduced by cost + commission
  const afterBuy = 10000 - config.buyAmountUsdt - trade.commission;
  assert.strictEqual(Number(engine.balance.usdt.toFixed(2)), Number(afterBuy.toFixed(2)));

  await engine.closeTrade(trade, 'manual_close', 110);
  const finalBalance = engine.balance.usdt;
  const balanceDiff = finalBalance - 10000;
  assert.strictEqual(balanceDiff.toFixed(2), trade.profitLossUsdt.toFixed(2));
}
