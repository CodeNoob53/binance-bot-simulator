import assert from 'assert';
import { getDatabase, closeDatabase } from '../src/database/init.js';
import { TradingSimulator } from '../src/simulation/simulator.js';

export async function testFetchKlinesDoesNotThrow() {
  process.env.DB_PATH = ':memory:';
  const db = await getDatabase();

  const symbolId = 1;
  const symbol = 'TESTUSDT';
  const listingDate = Date.now();

  const insert = `INSERT INTO historical_klines (
    symbol_id, open_time, close_time, open_price, high_price, low_price,
    close_price, volume, quote_asset_volume, number_of_trades,
    taker_buy_base_asset_volume, taker_buy_quote_asset_volume
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  for (let i = 0; i < 20; i++) {
    const openTime = listingDate + i * 60_000;
    const closeTime = openTime + 59_000;
    await db.run(
      insert,
      symbolId,
      openTime,
      closeTime,
      1 + i,
      1.1 + i,
      0.9 + i,
      1.05 + i,
      100 + i,
      110 + i,
      10,
      50,
      55
    );
  }

  const sim = new TradingSimulator({
    name: 'Test',
    takeProfitPercent: 0.02,
    stopLossPercent: 0.01,
    buyAmountUsdt: 10,
    maxOpenTrades: 1,
    trailingStopEnabled: false
  });

  const data = await sim.getMarketDataForListing(symbolId, symbol, listingDate);
  assert(data);
  const first = data.klines[0];
  assert('open' in first);
  assert('high' in first);
  assert('low' in first);
  assert('close' in first);
  assert('quoteAssetVolume' in first);

  await closeDatabase();
}

export async function testSaveSimulationSummaryInsertsRow() {
  process.env.DB_PATH = ':memory:';
  const db = await getDatabase();

  const sim = new TradingSimulator({
    name: 'Test',
    takeProfitPercent: 0.02,
    stopLossPercent: 0.01,
    buyAmountUsdt: 10,
    maxOpenTrades: 1,
    trailingStopEnabled: false
  });

  sim.completedTrades.push(
    { profitLossUsdt: 5, profitLossPercent: 5 },
    { profitLossUsdt: -2, profitLossPercent: -2 }
  );

  const summary = {
    configId: 1,
    totalTrades: 2,
    profitableTrades: 1,
    losingTrades: 1,
    totalReturn: 3,
    winRate: 50,
    roiPercent: 30,
    sharpeRatio: 1,
    maxDrawdown: 5,
    averageTradeTime: 0
  };

  await sim.saveSummaryToDatabase(1, summary);
  const row = await db.get('SELECT * FROM simulation_summary WHERE config_id = 1');
  assert(row);

  await closeDatabase();
}

export async function testTrailingStopSavesResult() {
  process.env.DB_PATH = ':memory:';
  const db = await getDatabase();

  const sim = new TradingSimulator({
    name: 'TrailingTest',
    takeProfitPercent: 0.30,
    stopLossPercent: 0.05,
    buyAmountUsdt: 10,
    maxOpenTrades: 1,
    trailingStopEnabled: true,
    trailingStopPercent: 0.05,
    trailingStopActivationPercent: 0.1,
    binanceFeePercent: 0.1
  });

  const marketData = {
    symbol: 'TSTUSDT',
    symbolId: 1,
    ticker: { price: '100', volume: '1000', priceChangePercent: '0' },
    orderBook: { bids: [['100', '1']], asks: [['101', '1']] },
    klines: [
      { open: '100', high: '100', low: '100', close: '100' },
      { open: '100', high: '112', low: '100', close: '112' },
      { open: '112', high: '112', low: '104', close: '105' }
    ],
    listingDate: Date.now(),
    currentTime: Date.now() + 180000
  };

  await sim.executeTrade(marketData, 1);
  const rows = await db.all('SELECT * FROM simulation_results');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].exit_reason, 'timeout');

  await closeDatabase();
}
