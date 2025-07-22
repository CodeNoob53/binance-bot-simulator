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
  
  async analyzeSymbolListing(symbol, workerId = 0) {
    const maxRetries = 2;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      logger.info(`[Worker ${workerId}] Processing ${symbol.symbol} - attempt ${attempt}/${maxRetries}`);
      try {
        const listingDate = await this.determineListingDate(symbol);
        
        if (listingDate) {
          await this.saveListingAnalysis(symbol.id, listingDate, 'analyzed');
          logger.info(`[Worker ${workerId}] Finished ${symbol.symbol} successfully`);
          return { symbol: symbol.symbol, success: true, listingDate };
        } else {
          await this.saveListingAnalysis(symbol.id, null, 'no_data');
          logger.info(`[Worker ${workerId}] Finished ${symbol.symbol} with no data`);
          return { symbol: symbol.symbol, success: false, reason: 'no_data' };
        }

      } catch (error) {
        logger.warn(`Attempt ${attempt}/${maxRetries} failed for ${symbol.symbol}: ${error.message}`);

        if (attempt === maxRetries) {
          await this.saveListingAnalysis(symbol.id, null, 'error', error.message);
          logger.info(`[Worker ${workerId}] Finished ${symbol.symbol} with error`);
          return { symbol: symbol.symbol, success: false, reason: error.message };
        }

        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  
  async determineListingDate(symbol) {
    logger.debug(`Determining precise listing date for ${symbol.symbol}`);

    // Try to obtain listing info directly from exchange metadata
    try {
      const exchangeInfo = await this.binanceClient.getExchangeInfo();
      if (exchangeInfo && Array.isArray(exchangeInfo.symbols)) {
        const meta = exchangeInfo.symbols.find(s => s.symbol === symbol.symbol);
        if (meta && meta.onboardDate && meta.onboardDate !== 0) {
          logger.info(`${symbol.symbol} onboard date found in exchange info`);
          return meta.onboardDate;
        }
      }
    } catch (err) {
      logger.debug(`Could not get exchange info for ${symbol.symbol}: ${err.message}`);
    }

    // Спочатку отримуємо денні свічки за останні 2 роки для широкого пошуку
    const twoYearsAgo = Date.now() - (2 * 365 * 24 * 60 * 60 * 1000);
    
    const dailyKlines = await this.binanceClient.getKlines(
      symbol.symbol,
      '1d',
      twoYearsAgo,
      Date.now(),
      1000
    );
    
    if (!dailyKlines || dailyKlines.length === 0) {
      logger.warn(`No daily kline data for ${symbol.symbol}`);
      return null;
    }
    
    // Знаходимо першу свічку з значним об'ємом (це більш точна дата лістингу)
    let listingTimestamp = null;
    let firstSignificantVolume = null;
    
    for (const kline of dailyKlines) {
      const [openTime, open, high, low, close, volume] = kline;
      const volumeNum = parseFloat(volume);
      
      // Перша свічка з об'ємом > 0 та ціною > 0
      if (volumeNum > 0 && parseFloat(open) > 0) {
        listingTimestamp = openTime;
        firstSignificantVolume = volumeNum;
        break;
      }
    }
    
    if (!listingTimestamp) {
      logger.warn(`No significant volume found for ${symbol.symbol}`);
      return dailyKlines[0][0]; // Fallback до першої свічки
    }
    
    // Додаткова перевірка: отримуємо годинні свічки навколо цієї дати для більшої точності
    const hourlyStartTime = listingTimestamp - (24 * 60 * 60 * 1000); // 24 години до
    const hourlyEndTime = listingTimestamp + (48 * 60 * 60 * 1000);   // 48 годин після
    
    try {
      const hourlyKlines = await this.binanceClient.getKlines(
        symbol.symbol,
        '1h',
        hourlyStartTime,
        hourlyEndTime,
        100
      );
      
      if (hourlyKlines && hourlyKlines.length > 0) {
        // Знаходимо першу годинну свічку з торгівлею
        for (const kline of hourlyKlines) {
          const [openTime, open, high, low, close, volume] = kline;
          if (parseFloat(volume) > 0 && parseFloat(open) > 0) {
            listingTimestamp = openTime;
            break;
          }
        }
      }
    } catch (error) {
      logger.debug(`Could not get hourly data for ${symbol.symbol}: ${error.message}`);
    }
    
    const listingDate = new Date(listingTimestamp);
    logger.info(`${symbol.symbol} precise listing: ${listingDate.toISOString()} (volume: ${firstSignificantVolume})`);
    
    return listingTimestamp;
  }
  
  async saveListingAnalysis(symbolId, listingDate, status, errorMessage = null) {
    const db = await this.dbPromise;
    await db.run(
      `INSERT INTO listing_analysis (
        symbol_id, listing_date, data_status, error_message, analysis_date
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(symbol_id) DO UPDATE SET
        listing_date = excluded.listing_date,
        data_status = excluded.data_status,
        error_message = excluded.error_message,
        analysis_date = excluded.analysis_date`,
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
