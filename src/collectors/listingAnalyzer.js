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
    
    try {
      // Спочатку отримуємо найстаріші свічки
      const twoYearsAgo = Date.now() - (2 * 365 * 24 * 60 * 60 * 1000);
      
      // Отримуємо перші доступні свічки
      const firstKlines = await this.binanceClient.getKlines(
        symbol.symbol,
        '1m',
        twoYearsAgo,
        Date.now(),
        1000
      );
      
      if (!firstKlines || firstKlines.length === 0) {
        logger.warn(`No kline data for ${symbol.symbol}`);
        return null;
      }
      
      // Перевірка чи отримали тільки одну свічку (символ делістингований або дуже новий)
      if (!Array.isArray(firstKlines) || firstKlines.length === 1) {
        logger.warn(`Only one kline returned for ${symbol.symbol}, might be delisted`);
        // Використовуємо дату цієї єдиної свічки
        const singleKline = Array.isArray(firstKlines) ? firstKlines[0] : firstKlines;
        if (singleKline && singleKline[0]) {
          return singleKline[0];
        }
        return null;
      }
      
      // Якщо перша свічка має об'єм - це може бути не точна дата лістингу
      let earliestTimestamp = firstKlines[0][0];
      
      // Пробуємо отримати ще старіші свічки (якщо є достатньо даних)
      if (firstKlines.length > 10) {
        let searchStartTime = earliestTimestamp - (30 * 24 * 60 * 60 * 1000);
        
        for (let i = 0; i < 3; i++) {
          try {
            const olderKlines = await this.binanceClient.getKlines(
              symbol.symbol,
              '1m',
              searchStartTime,
              earliestTimestamp,
              1000
            );
            
            if (!olderKlines || olderKlines.length === 0 || 
                (Array.isArray(olderKlines) && olderKlines.length === 1)) {
              // Не знайдено старіших свічок або символ делістингований
              break;
            }
            
            // Оновлюємо найранішу дату
            earliestTimestamp = olderKlines[0][0];
            searchStartTime = earliestTimestamp - (30 * 24 * 60 * 60 * 1000);
            
            await sleep(100); // Невелика затримка між запитами
          } catch (searchError) {
            logger.debug(`Search for older klines failed: ${searchError.message}`);
            break;
          }
        }
      }
      
      // Тепер визначаємо точну дату лістингу
      let actualListingTimestamp = null;
      
      // Отримуємо годинні свічки для більшої точності
      try {
        const searchRange = 7 * 24 * 60 * 60 * 1000; // 7 днів
        const preciseKlines = await this.binanceClient.getKlines(
          symbol.symbol,
          '1h',
          Math.max(earliestTimestamp - searchRange, 0),
          earliestTimestamp + searchRange,
          500
        );
        
        if (preciseKlines && Array.isArray(preciseKlines) && preciseKlines.length > 1) {
          // Знаходимо першу свічку з реальним об'ємом торгів
          for (const kline of preciseKlines) {
            const [openTime, open, high, low, close, volume] = kline;
            const volumeNum = parseFloat(volume);
            const openPrice = parseFloat(open);
            
            // Перевіряємо чи є реальна торгівля
            if (volumeNum > 0 && openPrice > 0) {
              actualListingTimestamp = openTime;
              
              // Спробуємо знайти ще точніший час через хвилинні свічки
              try {
                const minuteKlines = await this.binanceClient.getKlines(
                  symbol.symbol,
                  '1m',
                  Math.max(openTime - (60 * 60 * 1000), 0),
                  openTime + (60 * 60 * 1000),
                  120
                );
                
                if (minuteKlines && Array.isArray(minuteKlines) && minuteKlines.length > 1) {
                  for (const minuteKline of minuteKlines) {
                    const minuteVolume = parseFloat(minuteKline[5]);
                    if (minuteVolume > 0) {
                      actualListingTimestamp = minuteKline[0];
                      break;
                    }
                  }
                }
              } catch (minuteError) {
                logger.debug(`Could not get minute precision: ${minuteError.message}`);
              }
              
              break;
            }
          }
        }
      } catch (preciseError) {
        logger.debug(`Could not get hourly data: ${preciseError.message}`);
      }
      
      // Якщо не знайшли точну дату - використовуємо найранішу свічку
      if (!actualListingTimestamp) {
        actualListingTimestamp = earliestTimestamp;
      }
      
      const listingDate = new Date(actualListingTimestamp);
      logger.info(`${symbol.symbol} listing date: ${listingDate.toISOString()}`);
      
      return actualListingTimestamp;
      
    } catch (error) {
      logger.error(`Failed to determine listing date for ${symbol.symbol}: ${error.message}`);
      throw error;
    }
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