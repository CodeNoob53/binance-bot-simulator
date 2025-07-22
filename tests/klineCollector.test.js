import assert from 'assert';
import { getDatabase, closeDatabase } from '../src/database/init.js';
import { SymbolModel, HistoricalKlineModel } from '../src/database/models.js';
import { KlineCollector } from '../src/collectors/klineCollector.js';

export async function testCollectSymbolKlinesSavesEnoughRows() {
  process.env.DB_PATH = ':memory:';
  await getDatabase();
  const symbolModel = new SymbolModel();
  const klineModel = new HistoricalKlineModel();

  const symbolId = await symbolModel.create({
    symbol: 'TESTUSDT',
    baseAsset: 'TEST',
    quoteAsset: 'USDT'
  });

  const start = Date.now() - 50 * 60 * 60 * 1000; // 50 hours ago
  const klines = [];
  for (let i = 0; i < 48 * 60; i++) {
    const open = start + i * 60_000;
    klines.push([open, '1', '1', '1', '1', '1', open + 59_000, '1', 1, '1', '1']);
  }

  const collector = new KlineCollector();
  collector.binanceClient = {
    async getHistoricalKlines() {
      return klines;
    }
  };

  await collector.collectSymbolKlines({
    symbol_id: symbolId,
    symbol: 'TESTUSDT',
    listing_date: start
  });

  const count = await klineModel.getKlineCount(symbolId);
  assert(count >= 2880);

  await closeDatabase();
}
