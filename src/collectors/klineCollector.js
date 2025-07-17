import { getBinanceClient } from '../api/binanceClient.js';
import { getDatabase } from '../database/init.js';
import { WorkerManager } from './workerManager.js';
import logger from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

export class KlineCollector {
  constructor() {
    this.binanceClient = getBinanceClient();
    this.dbPromise = getDatabase();
    this.workersCount = parseInt(process.env.WORKERS_COUNT) || 10;
  }
  
  async collectRecentListingsData(daysBack = 180) {
    const cutoffDate = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    
    const newListings = await this.getNewListings(cutoffDate);
    logger.info(`Found ${newListings.length} new listings in the last ${daysBack} days`);
    
    if (newListings.length === 0) {
      return { successful: 0, failed: 0 };
    }
    
    const workerManager = new WorkerManager(this.workersCount);
    const results = await workerManager.processWithWorkers(
      newListings,
      this.collectSymbolKlines.bind(this)
    );
    
    return {
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    };
  }
  
  async collectSymbolKlines(listing, workerId = 0) {
    try {
      const { symbol_id, symbol, listing_date } = listing;
      
      // Збираємо дані за 48 годин з моменту лістингу
      const endTime = listing_date + (48 * 60 * 60 * 1000);
      const actualEndTime = Math.min(endTime, Date.now());
      
      logger.info(`[Worker ${workerId}] Collecting minute klines for ${symbol}: ${new Date(listing_date).toISOString()} to ${new Date(actualEndTime).toISOString()}`);
      
      const klines = await this.binanceClient.getHistoricalKlines(
        symbol,
        '1m',
        listing_date,
        actualEndTime
      );
      
      if (klines.length === 0) {
        logger.warn(`No minute data available for ${symbol}`);
        return { symbol, success: false, reason: 'no_data' };
      }
      
      // Зберігаємо в БД батчами
      await this.saveKlines(symbol_id, klines);
      
      logger.info(`[Worker ${workerId}] Saved ${klines.length} minute klines for ${symbol}`);

      logger.info(`[Worker ${workerId}] Finished collecting klines for ${symbol}`);
      
      return { symbol, success: true, klinesCount: klines.length };
      
    } catch (error) {
      logger.error(`Failed to collect klines for ${listing.symbol}:`, error.message);
      logger.info(`[Worker ${workerId}] Finished collecting klines for ${listing.symbol} with error`);
      return { symbol: listing.symbol, success: false, reason: error.message };
    }
  }
  
  async saveKlines(symbolId, klines, batchSize = 1000) {
    const db = await this.dbPromise;
    for (let i = 0; i < klines.length; i += batchSize) {
      const batch = klines.slice(i, i + batchSize);
      await db.exec('BEGIN');
      try {
        for (const kline of batch) {
          await db.run(
            `INSERT OR IGNORE INTO historical_klines (
              symbol_id, open_time, close_time, open_price, high_price, low_price,
              close_price, volume, quote_asset_volume, number_of_trades,
              taker_buy_base_asset_volume, taker_buy_quote_asset_volume
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            symbolId,
            kline[0],
            kline[6],
            parseFloat(kline[1]),
            parseFloat(kline[2]),
            parseFloat(kline[3]),
            parseFloat(kline[4]),
            parseFloat(kline[5]),
            parseFloat(kline[7]),
            kline[8],
            parseFloat(kline[9]),
            parseFloat(kline[10])
          );
        }
        await db.exec('COMMIT');
      } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  async getNewListings(cutoffDate) {
    const db = await this.dbPromise;
    return db.all(`
      SELECT
        s.id as symbol_id,
        s.symbol,
        la.listing_date
      FROM symbols s
      JOIN listing_analysis la ON s.id = la.symbol_id
      WHERE la.data_status = 'analyzed'
      AND la.listing_date >= ?
      AND NOT EXISTS (
        SELECT 1 FROM historical_klines hk 
        WHERE hk.symbol_id = s.id
        LIMIT 1
      )
      ORDER BY la.listing_date DESC
    `,
    cutoffDate);
  }
}
