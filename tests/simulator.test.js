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
    takeProfitPercent: 2,
    stopLossPercent: 1,
    buyAmountUsdt: 10,
    maxOpenTrades: 1,
    trailingStopEnabled: false
  });

  const data = await sim.getMarketDataForListing(symbolId, symbol, listingDate);
  assert(data);

  await closeDatabase();
}

export async function testSaveSimulationSummaryInsertsRow() {
  process.env.DB_PATH = ':memory:';
  const db = await getDatabase();

  const sim = new TradingSimulator({
    name: 'Test',
    takeProfitPercent: 2,
    stopLossPercent: 1,
    buyAmountUsdt: 10,
    maxOpenTrades: 1,
    trailingStopEnabled: false
  });

  sim.completedTrades.push(
    { profitLossUsdt: 5, profitLossPercent: 5 },
    { profitLossUsdt: -2, profitLossPercent: -2 }
  );
  sim.stats.totalTrades = 2;
  sim.stats.profitableTrades = 1;
  sim.stats.losingTrades = 1;

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

  await sim.saveSimulationSummary(summary);
  const row = await db.get('SELECT * FROM simulation_summary WHERE config_id = 1');
  assert(row);

  await closeDatabase();
}
