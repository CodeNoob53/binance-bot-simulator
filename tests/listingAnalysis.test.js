import assert from 'assert';
import { getDatabase, closeDatabase } from '../src/database/init.js';
import { SymbolModel } from '../src/database/models.js';
import { ListingAnalyzer } from '../src/collectors/listingAnalyzer.js';

export async function testListingAnalysisUpsert() {
  process.env.DB_PATH = ':memory:';
  const db = await getDatabase();
  const symbolModel = new SymbolModel();
  const symbolId = await symbolModel.create({
    symbol: 'TSTUSDT',
    baseAsset: 'TST',
    quoteAsset: 'USDT'
  });

  const analyzer = new ListingAnalyzer();
  await analyzer.saveListingAnalysis(symbolId, 100, 'analyzed');
  await db.run('UPDATE listing_analysis SET retry_count = 2 WHERE symbol_id = ?', symbolId);
  await analyzer.saveListingAnalysis(symbolId, 200, 'error', 'fail');

  const row = await db.get('SELECT * FROM listing_analysis WHERE symbol_id = ?', symbolId);
  assert.strictEqual(row.listing_date, 200);
  assert.strictEqual(row.data_status, 'error');
  assert.strictEqual(row.retry_count, 2);

  const count = (await db.get('SELECT COUNT(*) as c FROM listing_analysis')).c;
  assert.strictEqual(count, 1);

  await closeDatabase();
}

