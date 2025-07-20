import { getDatabase } from '../database/init.js';
import { SimulationConfigModel, SimulationResultModel, SimulationSummaryModel } from '../database/models.js';
import { NewListingScalperStrategy } from './strategies/newListingScalper.js';
import { validateMarketData } from '../utils/validators.js';
import logger from '../utils/logger.js';

export class TradingSimulator {
  constructor(config) {
    this.config = {
      name: config.name || 'Unknown Configuration',
      takeProfitPercent: config.takeProfitPercent || config.take_profit_percent || 0.02,
      stopLossPercent: config.stopLossPercent || config.stop_loss_percent || 0.01,
      trailingStopEnabled: Boolean(config.trailingStopEnabled || config.trailing_stop_enabled),
      trailingStopPercent: config.trailingStopPercent || config.trailing_stop_percent || null,
      trailingStopActivationPercent: config.trailingStopActivationPercent || config.trailing_stop_activation_percent || null,
      buyAmountUsdt: config.buyAmountUsdt || config.buy_amount_usdt || 100,
      maxOpenTrades: config.maxOpenTrades || config.max_open_trades || 3,
      minLiquidityUsdt: config.minLiquidityUsdt || config.min_liquidity_usdt || 10000,
      binanceFeePercent: config.binanceFeePercent || config.binance_fee_percent || 0.00075,
      cooldownSeconds: config.cooldownSeconds || config.cooldown_seconds || 300
    };
    
    this.dbPromise = getDatabase();
    this.configModel = new SimulationConfigModel();
    this.resultModel = new SimulationResultModel();
    this.summaryModel = new SimulationSummaryModel();
    
    // Ініціалізація стратегії (з fallback)
    try {
      this.strategy = new NewListingScalperStrategy(this.config);
    } catch (error) {
      logger.warn(`Failed to initialize strategy: ${error.message}, using fallback`);
      this.strategy = new FallbackStrategy(this.config);
    }
    
    // Статистика симуляції
    this.currentBalance = parseFloat(process.env.INITIAL_BALANCE_USDT) || 10000;
    this.initialBalance = this.currentBalance;
    this.activeTrades = new Map();
    this.completedTrades = [];
    this.processedListings = 0;
    this.skippedListings = 0;
    this.skipReasonCounts = {};
    this.simulationStartTime = Date.now();
  }

  /**
   * Запуск симуляції
   */
  async runSimulation(daysBack = 30) {
    logger.info(`Starting simulation: ${this.config.name}`);
    logger.info(`Initial balance: ${this.currentBalance} USDT`);
    
    try {
      // Збереження конфігурації
      const configId = await this.saveConfiguration();
      if (!configId) {
        throw new Error('Failed to save simulation configuration');
      }

      // Рання перевірка наявності даних
      const dataValidation = await this.validateDataAvailability(daysBack);
      if (!dataValidation.hasValidData) {
        logger.warn(`⚠️ Limited market data for simulation period`);
        logger.warn(`📊 Available symbols with data: ${dataValidation.availableSymbols}`);
        logger.warn(`📅 Data period: ${dataValidation.dateRange}`);
      }

      // Отримання лістингів з перевіркою
      const newListings = await this.getNewListingsWithData(daysBack);
      
      if (newListings.length === 0) {
        logger.warn('⚠️ No listings found for simulation period');
        const emptyResults = await this.createEmptyResults(configId, { reason: 'no_listings' });
        return emptyResults;
      }

      logger.info(`Found ${newListings.length} listings to simulate`);

      // Обробка кожного лістингу
      let processed = 0;
      for (const listing of newListings) {
        try {
          const result = await this.processListing(listing, configId);
          processed++;
          
          // Логування прогресу
          if (processed % 10 === 0 || processed === newListings.length) {
            const progressPercent = ((processed / newListings.length) * 100).toFixed(1);
            logger.info(`Simulation progress: ${progressPercent}% (${processed}/${newListings.length})`);
          }
          
        } catch (error) {
          logger.error(`Error processing listing ${listing.symbol}: ${error.message}`);
          this.skippedListings++;
          this.incrementSkipReason('processing_error');
        }
      }
      
      // Закриття активних угод
      await this.closeAllActiveTrades('simulation_ended', configId);

      // Генерація результатів
      const results = await this.generateResults(configId);
      
      // Детальне логування результатів
      this.logSimulationSummary(results);
      
      return results;
      
    } catch (error) {
      logger.error(`Simulation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Валідація наявності даних перед симуляцією
   */
  async validateDataAvailability(daysBack) {
    try {
      const db = await this.dbPromise;
      const cutoffDate = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
      
      // Перевірка загальної кількості даних
      const totalData = await db.get(`
        SELECT 
          COUNT(DISTINCT s.id) as total_symbols,
          COUNT(hk.id) as total_klines,
          MIN(datetime(hk.open_time/1000, 'unixepoch')) as earliest_date,
          MAX(datetime(hk.close_time/1000, 'unixepoch')) as latest_date
        FROM symbols s
        LEFT JOIN historical_klines hk ON s.id = hk.symbol_id
      `);
      
      // Перевірка символів з достатньою кількістю даних
      const validSymbols = await db.get(`
        SELECT COUNT(DISTINCT s.id) as count
        FROM symbols s
        INNER JOIN historical_klines hk ON s.id = hk.symbol_id
        WHERE s.quote_asset = 'USDT'
        GROUP BY s.id
        HAVING COUNT(hk.id) >= 10
      `);
      
      return {
        hasValidData: validSymbols?.count > 0,
        availableSymbols: validSymbols?.count || 0,
        totalSymbols: totalData.total_symbols,
        totalKlines: totalData.total_klines,
        dateRange: `${totalData.earliest_date} - ${totalData.latest_date}`
      };
      
    } catch (error) {
      logger.error(`Error validating data availability: ${error.message}`);
      return { hasValidData: false, availableSymbols: 0 };
    }
  }

  /**
   * Отримання лістингів з історичними даними
   */
  async getNewListingsWithData(daysBack) {
    try {
      const db = await this.dbPromise;
      
      // Діагностична інформація
      const totalSymbols = await db.get('SELECT COUNT(*) as count FROM symbols');
      const totalKlines = await db.get('SELECT COUNT(*) as count FROM historical_klines');
      const analyzedListings = await db.get(`
        SELECT COUNT(*) as count FROM listing_analysis WHERE data_status = 'analyzed'
      `);
      
      logger.info(`Database status: ${totalSymbols.count} symbols, ${totalKlines.count} klines, ${analyzedListings.count} analyzed`);
      
      // Спрощений запит для отримання символів з даними
      const symbolsWithKlines = await db.all(`
        SELECT DISTINCT
          s.id as symbol_id,
          s.symbol,
          COALESCE(la.listing_date, MIN(hk.open_time)) as listing_date,
          COUNT(hk.id) as klines_count,
          MIN(hk.open_time) as first_kline,
          MAX(hk.close_time) as last_kline
        FROM symbols s
        INNER JOIN historical_klines hk ON s.id = hk.symbol_id
        LEFT JOIN listing_analysis la ON s.id = la.symbol_id
        WHERE s.quote_asset = 'USDT'
        GROUP BY s.id, s.symbol
        HAVING klines_count >= 10
        ORDER BY listing_date DESC
        LIMIT 100
      `);
      
      logger.info(`Found ${symbolsWithKlines.length} symbols with historical data`);
      
      if (symbolsWithKlines.length === 0) {
        logger.warn('No symbols with kline data found!');
        
        // Додаткова діагностика
        const sampleSymbols = await db.all('SELECT symbol FROM symbols LIMIT 5');
        const sampleKlines = await db.all(`
          SELECT s.symbol, COUNT(hk.id) as count 
          FROM symbols s 
          LEFT JOIN historical_klines hk ON s.id = hk.symbol_id 
          GROUP BY s.id 
          LIMIT 5
        `);
        
        logger.info('Sample symbols:', sampleSymbols);
        logger.info('Sample kline counts:', sampleKlines);
      }
      
      return symbolsWithKlines;
      
    } catch (error) {
      logger.error(`Failed to fetch listings with data: ${error.message}`);
      return [];
    }
  }

  /**
   * Обробка одного лістингу
   */
  async processListing(listing, configId) {
    const { symbol_id, symbol, listing_date, klines_count } = listing;
    
    try {
      // Перевірка кількості даних
      if (klines_count < 10) {
        this.skippedListings++;
        this.incrementSkipReason('insufficient_klines');
        logger.debug(`Skipping ${symbol}: insufficient_klines (${klines_count})`);
        return { processed: false, reason: 'insufficient_klines' };
      }

      // Отримання ринкових даних
      const marketData = await this.getMarketDataForListing(symbol_id, symbol, listing_date);

      if (!marketData || !marketData.klines || marketData.klines.length < 3) {
        this.skippedListings++;
        this.incrementSkipReason('no_market_data');
        logger.debug(`Skipping ${symbol}: no_market_data`);
        return { processed: false, reason: 'no_market_data' };
      }
      
      // Валідація ринкових даних
      try {
        const validation = validateMarketData(marketData);
        if (!validation.isValid) {
          logger.debug(`Invalid market data for ${symbol}: ${validation.errors.join(', ')}`);
          this.skippedListings++;
          this.incrementSkipReason('invalid_data');
          return { processed: false, reason: 'invalid_data', errors: validation.errors };
        }
      } catch (validationError) {
        logger.debug(`Market data validation failed for ${symbol}: ${validationError.message}`);
        this.skippedListings++;
        this.incrementSkipReason('validation_error');
        return { processed: false, reason: 'validation_error' };
      }
      
      // Перевірка умов входу (з fallback)
      let entryConditions;
      try {
        entryConditions = await this.strategy.checkEntryConditions(marketData);
      } catch (strategyError) {
        logger.debug(`Strategy error for ${symbol}: ${strategyError.message}`);
        // Fallback - простіші умови
        entryConditions = this.checkBasicEntryConditions(marketData);
      }
      
      if (!entryConditions.shouldEnter) {
        this.skippedListings++;
        this.incrementSkipReason(entryConditions.reason);
        logger.debug(`Entry conditions not met for ${symbol}: ${entryConditions.reason}`);
        return { processed: false, reason: entryConditions.reason };
      }
      
      // Перевірка балансу
      if (this.currentBalance < this.config.buyAmountUsdt) {
        this.skippedListings++;
        this.incrementSkipReason('insufficient_balance');
        logger.debug(`Skipping ${symbol}: insufficient_balance`);
        return { processed: false, reason: 'insufficient_balance' };
      }
      
      // Виконання торгівлі
      const tradeResult = await this.executeTrade(marketData, configId);
      if (tradeResult.success) {
        this.processedListings++;
      }
      
      return { processed: tradeResult.success, trade: tradeResult };
      
    } catch (error) {
      logger.error(`Error processing listing ${symbol}: ${error.message}`);
      this.skippedListings++;
      this.incrementSkipReason('processing_error');
      return { processed: false, reason: 'processing_error', error: error.message };
    }
  }

  /**
   * Отримання ринкових даних для лістингу
   */
  async getMarketDataForListing(symbolId, symbol, listingDate) {
    try {
      const klinesQuery = `
        SELECT open_time, close_time, open_price, high_price, low_price, 
               close_price, volume, quote_asset_volume
        FROM historical_klines
        WHERE symbol_id = ? 
        AND open_time >= ? 
        AND open_time <= ?
        ORDER BY open_time ASC 
        LIMIT 50
      `;
      
      const startTime = listingDate || Date.now() - (24 * 60 * 60 * 1000);
      const endTime = startTime + (60 * 60 * 1000); // 1 година після лістингу
      
      const db = await this.dbPromise;
      const klines = await db.all(klinesQuery, symbolId, startTime, endTime);
      
      if (klines.length < 3) {
        // Спробуємо отримати будь-які дані для цього символу
        const anyKlines = await db.all(`
          SELECT open_time, close_time, open_price, high_price, low_price, 
                 close_price, volume, quote_asset_volume
          FROM historical_klines
          WHERE symbol_id = ?
          ORDER BY open_time ASC 
          LIMIT 20
        `, symbolId);
        
        if (anyKlines.length < 3) {
          return null;
        }
        
        // Використовуємо перші доступні дані
        const klines = anyKlines;
        const adjustedStartTime = klines[0].open_time;
        const adjustedEndTime = klines[klines.length - 1].close_time;
        
        return this.buildMarketData(symbol, klines, adjustedStartTime, adjustedEndTime, symbolId);
      }
      
      return this.buildMarketData(symbol, klines, startTime, endTime, symbolId);
      
    } catch (error) {
      logger.error(`Failed to get market data for ${symbol}: ${error.message}`);
      return null;
    }
  }

  /**
   * Побудова об'єкта ринкових даних
   */
  buildMarketData(symbol, klines, startTime, endTime, symbolId) {
    const lastKline = klines[klines.length - 1];
    const ticker = {
      symbol,
      price: lastKline.close_price,
      volume: lastKline.volume,
      priceChangePercent: this.calculatePriceChange(klines)
    };
    
    const currentPrice = parseFloat(lastKline.close_price);
    const orderBook = this.generateSimulatedOrderBook(currentPrice);
    
    return {
      symbol,
      ticker,
      orderBook,
      klines: klines.map(k => ({
        open: k.open_price,
        high: k.high_price,
        low: k.low_price,
        close: k.close_price,
        volume: k.volume,
        quoteAssetVolume: k.quote_asset_volume,
        openTime: k.open_time,
        closeTime: k.close_time
      })),
      listingDate: startTime,
      currentTime: endTime,
      symbolId
    };
  }

  /**
   * Базові умови входу (fallback)
   */
  checkBasicEntryConditions(marketData) {
    const { ticker, klines } = marketData;
    
    // Перевірка ціни
    const currentPrice = parseFloat(ticker.price);
    if (!currentPrice || currentPrice <= 0) {
      return { shouldEnter: false, reason: 'invalid_price' };
    }

    // Перевірка об'єму
    const currentVolume = parseFloat(ticker.volume) || 0;
    if (currentVolume < 1000) {
      return { shouldEnter: false, reason: 'low_volume' };
    }

    // Перевірка волатільності
    if (klines.length >= 3) {
      const priceChanges = [];
      for (let i = 1; i < klines.length; i++) {
        const prevClose = parseFloat(klines[i-1].close);
        const currentClose = parseFloat(klines[i].close);
        const change = Math.abs((currentClose - prevClose) / prevClose);
        priceChanges.push(change);
      }
      
      const avgVolatility = priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;
      
      if (avgVolatility < 0.01 || avgVolatility > 0.30) {
        return { shouldEnter: false, reason: 'unsuitable_volatility' };
      }
    }

    return {
      shouldEnter: true,
      reason: 'basic_conditions_met',
      entryPrice: currentPrice
    };
  }

  /**
   * Виконання торгівлі (спрощена версія)
   */
  async executeTrade(marketData, configId) {
    try {
      const entryPrice = parseFloat(marketData.ticker.price);
      const quantity = this.config.buyAmountUsdt / entryPrice;
      const entryTime = marketData.currentTime || Date.now();
      
      // Розрахунок цілей
      const takeProfitPrice = entryPrice * (1 + this.config.takeProfitPercent);
      const stopLossPrice = entryPrice * (1 - this.config.stopLossPercent);
      
      // Симуляція виходу (спрощена логіка)
      const simulatedExit = this.simulateTradeExit(marketData, entryPrice, takeProfitPrice, stopLossPrice);
      
      // Розрахунок результату
      const buyCommission = this.config.buyAmountUsdt * this.config.binanceFeePercent;
      const sellAmount = quantity * simulatedExit.exitPrice;
      const sellCommission = sellAmount * this.config.binanceFeePercent;
      const netReceived = sellAmount - sellCommission;
      const profitLossUsdt = netReceived - this.config.buyAmountUsdt - buyCommission;
      const profitLossPercent = (profitLossUsdt / this.config.buyAmountUsdt) * 100;
      
      // Створення торгової операції
      const trade = {
        symbolId: marketData.symbolId,
        symbol: marketData.symbol,
        entryTime,
        entryPrice,
        exitTime: simulatedExit.exitTime,
        exitPrice: simulatedExit.exitPrice,
        exitReason: simulatedExit.reason,
        quantity,
        profitLossUsdt,
        profitLossPercent,
        buyCommission,
        sellCommission
      };
      
      // Оновлення балансу та статистики
      this.currentBalance += profitLossUsdt;
      this.completedTrades.push(trade);
      
      // Збереження в БД
      await this.saveTradeToDatabase(configId, trade);
      
      logger.debug(`Trade executed: ${marketData.symbol} ${profitLossPercent.toFixed(2)}% (${simulatedExit.reason})`);
      
      return { success: true, trade };
      
    } catch (error) {
      logger.error(`Trade execution failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Симуляція виходу з торгівлі
   */
  simulateTradeExit(marketData, entryPrice, takeProfitPrice, stopLossPrice) {
    const klines = marketData.klines;
    const entryTime = marketData.currentTime || Date.now();
    
    // Перевіряємо наступні свічки після входу
    for (let i = 1; i < klines.length; i++) {
      const kline = klines[i];
      const high = parseFloat(kline.high);
      const low = parseFloat(kline.low);
      const close = parseFloat(kline.close);
      const time = kline.closeTime;
      
      // Take Profit досягнуто
      if (high >= takeProfitPrice) {
        return {
          exitPrice: takeProfitPrice,
          exitTime: time,
          reason: 'take_profit'
        };
      }
      
      // Stop Loss досягнуто
      if (low <= stopLossPrice) {
        return {
          exitPrice: stopLossPrice,
          exitTime: time,
          reason: 'stop_loss'
        };
      }
    }
    
    // Якщо не досягли цілей - вихід за ціною закриття останньої свічки
    const lastKline = klines[klines.length - 1];
    return {
      exitPrice: parseFloat(lastKline.close),
      exitTime: lastKline.closeTime,
      reason: 'timeout'
    };
  }

  /**
   * Збереження торгівлі в БД
   */
  async saveTradeToDatabase(configId, trade) {
    try {
      const db = await this.dbPromise;
      await db.run(`
        INSERT INTO simulation_results (
          config_id, symbol_id, entry_time, entry_price, exit_time, exit_price,
          exit_reason, quantity, profit_loss_usdt, profit_loss_percent,
          buy_commission, sell_commission
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        configId, trade.symbolId, trade.entryTime, trade.entryPrice,
        trade.exitTime, trade.exitPrice, trade.exitReason, trade.quantity,
        trade.profitLossUsdt, trade.profitLossPercent,
        trade.buyCommission, trade.sellCommission
      );
    } catch (error) {
      logger.error(`Failed to save trade to database: ${error.message}`);
    }
  }

  /**
   * Збереження конфігурації
   */
  async saveConfiguration() {
    try {
      const normalizedConfig = {
        name: this.config.name,
        takeProfitPercent: this.config.takeProfitPercent,
        stopLossPercent: this.config.stopLossPercent,
        trailingStopEnabled: Boolean(this.config.trailingStopEnabled),
        trailingStopPercent: this.config.trailingStopPercent,
        trailingStopActivationPercent: this.config.trailingStopActivationPercent,
        buyAmountUsdt: this.config.buyAmountUsdt,
        maxOpenTrades: this.config.maxOpenTrades,
        minLiquidityUsdt: this.config.minLiquidityUsdt,
        binanceFeePercent: this.config.binanceFeePercent,
        cooldownSeconds: this.config.cooldownSeconds
      };
      
      return await this.configModel.create(normalizedConfig);
    } catch (error) {
      logger.error('Error saving configuration:', error);
      throw new Error(`Failed to save simulation configuration: ${error.message}`);
    }
  }

  /**
   * Генерація результатів
   */
  async generateResults(configId) {
    try {
      const summary = {
        configName: this.config?.name || 'Unknown',
        totalTrades: this.completedTrades?.length || 0,
        profitableTrades: this.completedTrades?.filter(t => t.profitLossUsdt > 0).length || 0,
        losingTrades: this.completedTrades?.filter(t => t.profitLossUsdt < 0).length || 0,
        winRate: 0,
        totalReturn: 0,
        roiPercent: 0,
        initialBalance: this.initialBalance,
        finalBalance: this.currentBalance,
        maxDrawdown: 0,
        sharpeRatio: 0,
        profitFactor: 0,
        processedListings: this.processedListings || 0,
        skippedListings: this.skippedListings || 0,
        skipReasonStats: this.skipReasonCounts || {},
        simulationDuration: Date.now() - (this.simulationStartTime || Date.now()),
        averageTradeTime: 0
      };

      // Розрахунки тільки якщо є угоди
      if (summary.totalTrades > 0) {
        summary.winRate = (summary.profitableTrades / summary.totalTrades) * 100;
        summary.totalReturn = this.currentBalance - summary.initialBalance;
        summary.roiPercent = (summary.totalReturn / summary.initialBalance) * 100;
        
        // Середній час угоди
        const totalDuration = this.completedTrades.reduce((sum, trade) => {
          return sum + ((trade.exitTime || Date.now()) - (trade.entryTime || Date.now()));
        }, 0);
        summary.averageTradeTime = totalDuration / summary.totalTrades / (1000 * 60); // хвилини
        
        // Profit Factor
        const totalProfit = this.completedTrades
          .filter(t => t.profitLossUsdt > 0)
          .reduce((sum, t) => sum + t.profitLossUsdt, 0);
        const totalLoss = Math.abs(this.completedTrades
          .filter(t => t.profitLossUsdt < 0)
          .reduce((sum, t) => sum + t.profitLossUsdt, 0));
        
        summary.profitFactor = totalLoss > 0 ? totalProfit / totalLoss : 0;
      }

      // Збереження в базу даних
      if (configId) {
        await this.saveSummaryToDatabase(configId, summary);
      }

      return {
        summary,
        trades: this.completedTrades || []
      };
      
    } catch (error) {
      logger.error(`Error generating results: ${error.message}`);
      
      return {
        summary: {
          configName: this.config?.name || 'Error',
          totalTrades: 0,
          profitableTrades: 0,
          losingTrades: 0,
          winRate: 0,
          totalReturn: 0,
          roiPercent: 0,
          initialBalance: this.currentBalance,
          finalBalance: this.currentBalance,
          error: error.message
        },
        trades: []
      };
    }
  }

  /**
   * Створення порожнього результату
   */
  async createEmptyResults(configId, validationInfo) {
    try {
      await this.saveSummaryToDatabase(configId, {
        totalTrades: 0,
        profitableTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalReturn: 0,
        roiPercent: 0,
        averageTradeTime: 0
      });

      return {
        summary: {
          configName: this.config.name,
          totalTrades: 0,
          profitableTrades: 0,
          losingTrades: 0,
          winRate: 0,
          totalReturn: 0,
          roiPercent: 0,
          initialBalance: this.currentBalance,
          finalBalance: this.currentBalance,
          maxDrawdown: 0,
          sharpeRatio: 0,
          profitFactor: 0,
          processedListings: 0,
          skippedListings: this.skippedListings,
          skipReasonStats: this.skipReasonCounts,
          simulationDuration: Date.now() - this.simulationStartTime,
          noDataReason: validationInfo
        },
        trades: []
      };
    } catch (error) {
      logger.error(`Error creating empty results: ${error.message}`);
      throw error;
    }
  }

  /**
   * Збереження результатів в базу даних
   */
  async saveSummaryToDatabase(configId, summary) {
    try {
      const db = await this.dbPromise;
      
      await db.run(`
        INSERT INTO simulation_summary (
          config_id, total_trades, profitable_trades, losing_trades,
          timeout_trades, trailing_stop_trades, total_profit_usdt, total_loss_usdt,
          net_profit_usdt, win_rate_percent, avg_profit_percent, avg_loss_percent,
          max_profit_percent, max_loss_percent, avg_trade_duration_minutes,
          total_simulation_period_days, roi_percent, sharpe_ratio, max_drawdown_percent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        configId,
        summary.totalTrades || 0,
        summary.profitableTrades || 0,
        summary.losingTrades || 0,
        0, // timeout_trades
        0, // trailing_stop_trades
        Math.max(0, summary.totalReturn || 0), // total_profit_usdt
        Math.abs(Math.min(0, summary.totalReturn || 0)), // total_loss_usdt
        summary.totalReturn || 0, // net_profit_usdt
        summary.winRate || 0,
        0, // avg_profit_percent
        0, // avg_loss_percent
        0, // max_profit_percent
        0, // max_loss_percent
        summary.averageTradeTime || 0,
        0, // total_simulation_period_days
        summary.roiPercent || 0,
        summary.sharpeRatio || 0,
        summary.maxDrawdown || 0
      );
      
    } catch (error) {
      logger.error(`Failed to save summary to database: ${error.message}`);
    }
  }

  /**
   * Детальне логування результатів симуляції
   */
  logSimulationSummary(results) {
    const summary = results.summary;
    
    logger.info('Simulation summary saved to database');
    logger.info(`Processed listings: ${summary.processedListings}`);
    logger.info(`Skipped listings: ${summary.skippedListings}`);
    logger.info(`Skip reasons: ${JSON.stringify(summary.skipReasonStats)}`);
    
    if (summary.totalTrades > 0) {
      logger.info(`Total trades: ${summary.totalTrades}`);
      logger.info(`Win rate: ${summary.winRate.toFixed(2)}%`);
      logger.info(`ROI: ${summary.roiPercent.toFixed(2)}%`);
      logger.info(`Net profit: ${summary.totalReturn.toFixed(2)} USDT`);
    } else {
      logger.warn(`⚠️ No trades executed during simulation`);
      if (summary.noDataReason) {
        logger.warn(`Reason: ${JSON.stringify(summary.noDataReason)}`);
      }
    }
    
    logger.info('Simulation completed successfully');
  }

  /**
   * Допоміжні методи
   */
  
  incrementSkipReason(reason) {
    if (!this.skipReasonCounts) {
      this.skipReasonCounts = {};
    }
    this.skipReasonCounts[reason] = (this.skipReasonCounts[reason] || 0) + 1;
  }

  async closeAllActiveTrades(reason, configId) {
    if (this.activeTrades && this.activeTrades.size > 0) {
      logger.info(`Closing ${this.activeTrades.size} active trades due to: ${reason}`);
      this.activeTrades.clear();
    }
  }

  calculatePriceChange(klines) {
    if (klines.length < 2) return '0.00';
    
    const firstPrice = parseFloat(klines[0].open_price);
    const lastPrice = parseFloat(klines[klines.length - 1].close_price);
    const change = ((lastPrice - firstPrice) / firstPrice) * 100;
    
    return change.toFixed(2);
  }

  generateSimulatedOrderBook(currentPrice) {
    const bids = [];
    const asks = [];
    const spread = currentPrice * 0.001; // 0.1% spread
    
    for (let i = 0; i < 5; i++) {
      const bidPrice = currentPrice - spread - (i * spread * 0.1);
      const askPrice = currentPrice + spread + (i * spread * 0.1);
      const quantity = Math.random() * 1000 + 100;
      
      bids.push([bidPrice.toFixed(8), quantity.toFixed(2)]);
      asks.push([askPrice.toFixed(8), quantity.toFixed(2)]);
    }
    
    return { bids, asks };
  }
}

/**
 * Fallback стратегія для випадків коли основна недоступна
 */
class FallbackStrategy {
  constructor(config) {
    this.config = config;
  }

  async checkEntryConditions(marketData) {
    const { ticker, klines } = marketData;
    
    // Базові перевірки
    const currentPrice = parseFloat(ticker.price);
    if (!currentPrice || currentPrice <= 0) {
      return { shouldEnter: false, reason: 'invalid_price' };
    }

    const currentVolume = parseFloat(ticker.volume) || 0;
    if (currentVolume < 1000) {
      return { shouldEnter: false, reason: 'low_volume' };
    }

    // Простий тренд-аналіз
    if (klines.length >= 3) {
      const recent = klines.slice(-3);
      const prices = recent.map(k => parseFloat(k.close));
      const isUptrend = prices[2] > prices[1] && prices[1] > prices[0];
      
      if (!isUptrend) {
        return { shouldEnter: false, reason: 'no_uptrend' };
      }
    }

    return {
      shouldEnter: true,
      reason: 'fallback_strategy_conditions_met',
      entryPrice: currentPrice
    };
  }
}

export default TradingSimulator;