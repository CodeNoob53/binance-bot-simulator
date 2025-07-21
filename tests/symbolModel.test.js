import assert from 'assert';
import { getDatabase, closeDatabase } from '../src/database/init.js';
import { SymbolModel, HistoricalKlineModel } from '../src/database/models.js';

export async function testGetSymbolsWithDataReturnsArray() {
  process.env.DB_PATH = ':memory:';
  await getDatabase();
  const symbolModel = new SymbolModel();
  const klineModel = new HistoricalKlineModel();

  const symbolId = await symbolModel.create({
    symbol: 'TSTUSDT',
    baseAsset: 'TST',
    quoteAsset: 'USDT'
  });

  await klineModel.createBatch([
    [symbolId, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  ]);

  const rows = await symbolModel.getSymbolsWithData();
  assert(Array.isArray(rows));
  assert.strictEqual(rows.length, 1);

  await closeDatabase();
}
