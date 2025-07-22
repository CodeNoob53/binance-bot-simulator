import assert from 'assert';
import { getDatabase, closeDatabase } from '../src/database/init.js';
import { SymbolModel, ListingAnalysisModel } from '../src/database/models.js';
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

export async function testListingAnalysisModelCreateUpsert() {
  process.env.DB_PATH = ':memory:';
  const db = await getDatabase();
  const symbolModel = new SymbolModel();
  const analysisModel = new ListingAnalysisModel();

  const symbolId = await symbolModel.create({
    symbol: 'MODUSDT',
    baseAsset: 'MOD',
    quoteAsset: 'USDT'
  });

  await analysisModel.create({ symbolId, listingDate: 123, dataStatus: 'pending' });
  await db.run('UPDATE listing_analysis SET retry_count = 5 WHERE symbol_id = ?', symbolId);
  await analysisModel.create({ symbolId, listingDate: 456, dataStatus: 'updated', errorMessage: 'err', retryCount: 1 });

  const row = await db.get('SELECT * FROM listing_analysis WHERE symbol_id = ?', symbolId);
  assert.strictEqual(row.listing_date, 456);
  assert.strictEqual(row.data_status, 'updated');
  assert.strictEqual(row.error_message, 'err');
  assert.strictEqual(row.retry_count, 1);

  const count = (await db.get('SELECT COUNT(*) as c FROM listing_analysis')).c;
  assert.strictEqual(count, 1);

  await closeDatabase();
}

export async function testDetermineListingDateUsesOnboardDate() {
  const analyzer = new ListingAnalyzer();
  let klinesCalled = false;

  analyzer.binanceClient = {
    async getExchangeInfo() {
      return { symbols: [{ symbol: 'AAAUSDT', onboardDate: 987654321 }] };
    },
    async getKlines() {
      klinesCalled = true;
      return [];
    }
  };

  const ts = await analyzer.determineListingDate({ symbol: 'AAAUSDT' });
  assert.strictEqual(ts, 987654321);
  assert.strictEqual(klinesCalled, false);
}

