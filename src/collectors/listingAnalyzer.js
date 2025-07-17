import { getBinanceClient } from '../api/binanceClient.js';
import { getDatabase } from '../database/init.js';
import { WorkerManager } from './workerManager.js';
import logger from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

export class ListingAnalyzer {
  constructor() {
    this.binanceClient = getBinanceClient();
    this.dbPromise = getDatabase();
    this.workersCount = parseInt(process.env.WORKERS_COUNT) || 10;
  }
  
  async analyzeListingDates() {
    const symbols = await this.getSymbolsForAnalysis();
    logger.info(`Found ${symbols.length} symbols for listing analysis`);
    
    if (symbols.length === 0) {
      return { analyzed: 0, failed: 0 };
    }
    
    const workerManager = new WorkerManager(this.workersCount);
    const results = await workerManager.processWithWorkers(
      symbols,
      this.analyzeSymbolListing.bind(this)
    );
    
    return {
      analyzed: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    };
  }
  
  async analyzeSymbolListing(symbol) {
    const maxRetries = 2;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const listingDate = await this.determineListingDate(symbol);
        
        if (listingDate) {
          await this.saveListingAnalysis(symbol.id, listingDate, 'analyzed');
          return { symbol: symbol.symbol, success: true, listingDate };
        } else {
          await this.saveListingAnalysis(symbol.id, null, 'no_data');
          return { symbol: symbol.symbol, success: false, reason: 'no_data' };
        }
        
      } catch (error) {
        logger.warn(`Attempt ${attempt}/${maxRetries} failed for ${symbol.symbol}: ${error.message}`);
        
        if (attempt === maxRetries) {
          await this.saveListingAnalysis(symbol.id, null, 'error', error.message);
          return { symbol: symbol.symbol, success: false, reason: error.message };
        }
        
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  
  async determineListingDate(symbol) {
    logger.debug(`Analyzing listing date for ${symbol.symbol}`);
    
    // Отримуємо денні свічки за останній рік
    const oneYearAgo = Date.now() - (365 * 24 * 60 * 60 * 1000);
    
    const dailyKlines = await this.binanceClient.getKlines(
      symbol.symbol,
      '1d',
      oneYearAgo,
      Date.now(),
      1000
    );
    
    if (!dailyKlines || dailyKlines.length === 0) {
      logger.warn(`No daily kline data for ${symbol.symbol}`);
      return null;
    }
    
    // Перша свічка = дата лістингу
    const listingTimestamp = dailyKlines[0][0];
    const listingDate = new Date(listingTimestamp);
    
    logger.info(`${symbol.symbol} listed on ${listingDate.toISOString()}`);
    
    return listingTimestamp;
  }
  
  async saveListingAnalysis(symbolId, listingDate, status, errorMessage = null) {
    const db = await this.dbPromise;
    await db.run(
      `INSERT OR REPLACE INTO listing_analysis
       (symbol_id, listing_date, data_status, error_message, analysis_date)
       VALUES (?, ?, ?, ?, ?)`,
      symbolId,
      listingDate,
      status,
      errorMessage,
      Date.now()
    );
  }

  async getSymbolsForAnalysis() {
    const db = await this.dbPromise;
    return db.all(`
      SELECT s.*
      FROM symbols s
      LEFT JOIN listing_analysis la ON s.id = la.symbol_id
      WHERE s.status = 'active'
      AND s.quote_asset = 'USDT'
      AND (la.id IS NULL OR (la.data_status = 'error' AND la.retry_count < 3))
      ORDER BY s.id
    `);
  }
}
