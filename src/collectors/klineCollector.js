// src/collectors/klineCollector.js
import { getBinanceClient } from '../api/binanceClient.js';
import { getDatabase } from '../database/init.js';
import { WorkerManager } from './workerManager.js';
import logger from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

export class KlineCollector {
  constructor() {
    this.binanceClient = getBinanceClient();
    this.dbPromise = getDatabase();
    this.workersCount = parseInt(process.env.WORKERS_COUNT) || 3; // Зменшуємо воркерів
    this.collectionStats = {
      totalSymbols: 0,
      successful: 0,
      failed: 0,
      startTime: null,
      errors: {}
    };
    
    // Черга для синхронізації збереження в БД
    this.saveQueue = [];
    this.isSaving = false;
  }
  
  async collectRecentListingsData(daysBack = 180) {
    this.collectionStats.startTime = Date.now();
    this.collectionStats.totalSymbols = 0;
    this.collectionStats.successful = 0;
    this.collectionStats.failed = 0;
    this.collectionStats.errors = {};
    
    const cutoffDate = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    
    logger.info(`Starting klines collection for listings from last ${daysBack} days`, {
      cutoffDate: new Date(cutoffDate).toISOString(),
      workers: this.workersCount
    });
    
    const newListings = await this.getNewListings(cutoffDate);
    this.collectionStats.totalSymbols = newListings.length;
    
    logger.info(`Found ${newListings.length} new listings in the last ${daysBack} days`);
    
    if (newListings.length === 0) {
      return { successful: 0, failed: 0, stats: this.collectionStats };
    }
    
    // Фільтруємо символи, які могли бути delisted
    const validListings = await this.filterValidListings(newListings);
    logger.info(`Filtered to ${validListings.length} valid listings`);
    
    const workerManager = new WorkerManager(this.workersCount);
    const results = await workerManager.processWithWorkers(
      validListings,
      this.collectSymbolKlines.bind(this)
    );
    
    // Дочекаємося завершення всіх операцій збереження
    await this.waitForAllSaves();
    
    // Обробка результатів
    this.processResults(results);
    
    // Логування фінальної статистики
    this.logFinalStats();
    
    return {
      successful: this.collectionStats.successful,
      failed: this.collectionStats.failed,
      stats: this.collectionStats
    };
  }
  
  async filterValidListings(listings) {
    logger.info('Filtering valid listings...');
    const validListings = [];
    
    try {
      // Отримуємо поточну інформацію про біржу
      const exchangeInfo = await this.binanceClient.getExchangeInfo();
      const activeSymbols = new Set(
        exchangeInfo.symbols
          .filter(s => s.status === 'TRADING' && s.isSpotTradingAllowed)
          .map(s => s.symbol)
      );
      
      for (const listing of listings) {
        if (activeSymbols.has(listing.symbol)) {
          validListings.push(listing);
        } else {
          logger.warn(`Symbol ${listing.symbol} is no longer trading, skipping`);
          this.addError('symbol_not_trading', listing.symbol);
        }
      }
      
    } catch (error) {
      logger.error('Failed to filter listings, proceeding with all:', error.message);
      return listings; // Якщо не можемо перевірити, пробуємо всі
    }
    
    return validListings;
  }
  
  async collectSymbolKlines(listing, workerId = 0) {
    const startTime = Date.now();
    
    try {
      const { symbol_id, symbol, listing_date } = listing;
      
      // Перевірка чи символ вже має дані
      if (await this.hasExistingData(symbol_id)) {
        logger.info(`[Worker ${workerId}] Symbol ${symbol} already has data, skipping`);
        return { symbol, success: true, reason: 'already_exists', klinesCount: 0 };
      }
      
      // Розрахунок періоду збору (48 годин з моменту лістингу)
      const collectionPeriod = this.calculateCollectionPeriod(listing_date);
      
      logger.info(`[Worker ${workerId}] Collecting minute klines for ${symbol}`, {
        listingDate: new Date(listing_date).toISOString(),
        startTime: new Date(collectionPeriod.start).toISOString(),
        endTime: new Date(collectionPeriod.end).toISOString(),
        durationHours: Math.round((collectionPeriod.end - collectionPeriod.start) / (1000 * 60 * 60))
      });
      
      // Збір даних з ретрай логікою
      const klines = await this.collectWithRetry(symbol, collectionPeriod, workerId);
      
      if (klines.length === 0) {
        logger.warn(`[Worker ${workerId}] No minute data available for ${symbol}`);
        this.addError('no_data', symbol);
        return { symbol, success: false, reason: 'no_data' };
      }
      
      // Валідація даних
      const validationResult = this.validateKlines(klines, symbol);
      if (!validationResult.valid) {
        logger.warn(`[Worker ${workerId}] Invalid klines data for ${symbol}:`, validationResult);
        this.addError('invalid_data', symbol);
        return { symbol, success: false, reason: 'invalid_data' };
      }
      
      // Додаємо до черги збереження (БЕЗ транзакцій тут)
      await this.queueSaveKlines(symbol_id, klines, symbol, workerId);
      
      const duration = Date.now() - startTime;
      logger.info(`[Worker ${workerId}] Successfully queued ${klines.length} minute klines for ${symbol}`, {
        duration: `${duration}ms`,
        coverage: validationResult.coverage,
        avgVolume: validationResult.avgVolume
      });
      
      this.collectionStats.successful++;
      return { symbol, success: true, klinesCount: klines.length };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[Worker ${workerId}] Failed to collect klines for ${listing.symbol}:`, {
        error: error.message,
        duration: `${duration}ms`,
        stack: error.stack
      });
      
      this.addError('collection_failed', listing.symbol, error.message);
      this.collectionStats.failed++;
      
      return { symbol: listing.symbol, success: false, reason: error.message };
    }
  }
  
  // НОВА ФУНКЦІЯ: Черга збереження для уникнення конфліктів транзакцій
  async queueSaveKlines(symbolId, klines, symbol, workerId) {
    return new Promise((resolve, reject) => {
      this.saveQueue.push({
        symbolId,
        klines,
        symbol,
        workerId,
        resolve,
        reject
      });
      
      // Запускаємо обробку черги якщо вона не запущена
      this.processSaveQueue();
    });
  }
  
  async processSaveQueue() {
    if (this.isSaving || this.saveQueue.length === 0) {
      return;
    }
    
    this.isSaving = true;
    
    while (this.saveQueue.length > 0) {
      const saveTask = this.saveQueue.shift();
      
      try {
        await this.saveKlinesSync(saveTask.symbolId, saveTask.klines);
        logger.info(`[Worker ${saveTask.workerId}] Saved ${saveTask.klines.length} klines for ${saveTask.symbol}`);
        saveTask.resolve();
      } catch (error) {
        logger.error(`Failed to save klines for ${saveTask.symbol}:`, error.message);
        saveTask.reject(error);
      }
      
      // Невелика затримка між збереженнями
      await sleep(10);
    }
    
    this.isSaving = false;
  }
  
  async waitForAllSaves() {
    // Чекаємо поки черга збереження не спорожніє
    while (this.saveQueue.length > 0 || this.isSaving) {
      await sleep(100);
    }
    logger.info('All save operations completed');
  }
  
  calculateCollectionPeriod(listingDate) {
    // Збираємо дані за 48 годин з моменту лістингу
    const start = listingDate;
    const end = Math.min(
      listingDate + (48 * 60 * 60 * 1000), // 48 годин
      Date.now() // Але не пізніше поточного часу
    );
    
    return { start, end };
  }
  
  async collectWithRetry(symbol, period, workerId, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const klines = await this.binanceClient.getHistoricalKlines(
          symbol,
          '1m',
          period.start,
          period.end
        );
        
        if (klines && klines.length > 0) {
          return klines;
        }
        
        if (attempt < maxRetries) {
          logger.warn(`[Worker ${workerId}] No data for ${symbol}, attempt ${attempt}/${maxRetries}, retrying...`);
          await sleep(2000 * attempt); // Прогресивна затримка
        }
        
      } catch (error) {
        // Детальний лог API помилок
        logger.error(`[Worker ${workerId}] API error for ${symbol} (attempt ${attempt}/${maxRetries}):`, {
          message: error.message,
          stack: error.stack,
          response: error.response ? {
            status: error.response.status,
            statusText: error.response.statusText,
            data: error.response.data
          } : 'No response'
        });
        
        if (attempt === maxRetries) {
          throw error;
        }
        
        // Довша затримка при API помилках
        await sleep(5000 * attempt);
      }
    }
    
    return [];
  }
  
  validateKlines(klines, symbol) {
    if (!Array.isArray(klines) || klines.length === 0) {
      return { valid: false, reason: 'empty_or_invalid_array' };
    }
    
    // Перевірка структури
    const invalidKlines = klines.filter(k => !Array.isArray(k) || k.length < 11);
    if (invalidKlines.length > 0) {
      return { 
        valid: false, 
        reason: 'invalid_structure',
        invalidCount: invalidKlines.length 
      };
    }
    
    // Перевірка даних
    let totalVolume = 0;
    let zeroVolumeCount = 0;
    
    for (const kline of klines) {
      const volume = parseFloat(kline[5]);
      totalVolume += volume;
      if (volume === 0) zeroVolumeCount++;
    }
    
    const avgVolume = totalVolume / klines.length;
    const zeroVolumePercent = (zeroVolumeCount / klines.length) * 100;
    
    // Якщо більше 90% свічок без об'єму - підозрюються дані
    if (zeroVolumePercent > 90) {
      logger.warn(`High zero-volume percentage for ${symbol}: ${zeroVolumePercent.toFixed(1)}%`);
    }
    
    const timeSpan = klines[klines.length - 1][6] - klines[0][0];
    const expectedMinutes = timeSpan / (1000 * 60);
    const coverage = (klines.length / expectedMinutes) * 100;
    
    return {
      valid: true,
      coverage: `${coverage.toFixed(1)}%`,
      avgVolume: avgVolume.toFixed(8),
      zeroVolumePercent: zeroVolumePercent.toFixed(1),
      timeSpan: `${Math.round(timeSpan / (1000 * 60 * 60))} hours`
    };
  }
  
  async hasExistingData(symbolId) {
    const db = await this.dbPromise;
    const count = await db.get(
      'SELECT COUNT(*) as count FROM historical_klines WHERE symbol_id = ?',
      symbolId
    );
    return count.count > 0;
  }
  
  // ВИПРАВЛЕНА ФУНКЦІЯ: Синхронне збереження без вкладених транзакцій
  async saveKlinesSync(symbolId, klines, batchSize = 500) {
    const db = await this.dbPromise;
    
    // Використовуємо WAL режим для кращої конкурентності
    await db.exec('PRAGMA journal_mode = WAL');
    await db.exec('PRAGMA synchronous = NORMAL');
    await db.exec('PRAGMA cache_size = 10000');
    
    let savedCount = 0;
    
    // Обробляємо батчами БЕЗ вкладених транзакцій
    for (let i = 0; i < klines.length; i += batchSize) {
      const batch = klines.slice(i, i + batchSize);
      
      // ОДНА транзакція на весь батч
      await db.exec('BEGIN IMMEDIATE'); // IMMEDIATE для кращого контролю блокувань
      
      try {
        const stmt = await db.prepare(`
          INSERT OR IGNORE INTO historical_klines (
            symbol_id, open_time, close_time, open_price, high_price, low_price,
            close_price, volume, quote_asset_volume, number_of_trades,
            taker_buy_base_asset_volume, taker_buy_quote_asset_volume
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        for (const kline of batch) {
          await stmt.run(
            symbolId,
            kline[0],  // open_time
            kline[6],  // close_time
            parseFloat(kline[1]),  // open_price
            parseFloat(kline[2]),  // high_price
            parseFloat(kline[3]),  // low_price
            parseFloat(kline[4]),  // close_price
            parseFloat(kline[5]),  // volume
            parseFloat(kline[7]),  // quote_asset_volume
            kline[8],  // number_of_trades
            parseFloat(kline[9]),  // taker_buy_base_asset_volume
            parseFloat(kline[10])  // taker_buy_quote_asset_volume
          );
        }
        
        await stmt.finalize();
        await db.exec('COMMIT');
        savedCount += batch.length;
        
      } catch (error) {
        await db.exec('ROLLBACK');
        logger.error(`Failed to save batch ${i}-${i + batch.length}:`, error.message);
        throw error;
      }
      
      // Невелика затримка між батчами для інших операцій
      if (i + batchSize < klines.length) {
        await sleep(5);
      }
    }
    
    return savedCount;
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
  
  addError(type, symbol, details = null) {
    if (!this.collectionStats.errors[type]) {
      this.collectionStats.errors[type] = [];
    }
    
    this.collectionStats.errors[type].push({
      symbol,
      details,
      timestamp: Date.now()
    });
  }
  
  processResults(results) {
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    this.collectionStats.successful = successful.length;
    this.collectionStats.failed = failed.length;
    
    // Групування помилок
    const errorGroups = {};
    failed.forEach(result => {
      const reason = result.reason || 'unknown';
      if (!errorGroups[reason]) {
        errorGroups[reason] = [];
      }
      errorGroups[reason].push(result.symbol);
    });
    
    // Логування груп помилок
    Object.entries(errorGroups).forEach(([reason, symbols]) => {
      logger.warn(`Collection failed (${reason}): ${symbols.length} symbols`, {
        reason,
        count: symbols.length,
        symbols: symbols.slice(0, 5), // Перші 5 для прикладу
        hasMore: symbols.length > 5
      });
    });
  }
  
  logFinalStats() {
    const duration = Date.now() - this.collectionStats.startTime;
    const successRate = ((this.collectionStats.successful / this.collectionStats.totalSymbols) * 100).toFixed(1);
    
    logger.info('Klines collection completed', {
      total: this.collectionStats.totalSymbols,
      successful: this.collectionStats.successful,
      failed: this.collectionStats.failed,
      successRate: `${successRate}%`,
      duration: `${Math.round(duration / 1000)}s`,
      workers: this.workersCount
    });
    
    // Детальний звіт про помилки
    if (Object.keys(this.collectionStats.errors).length > 0) {
      logger.warn('Error summary:', this.collectionStats.errors);
    }
  }
}