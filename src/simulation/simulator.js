import { getDatabase } from '../database/init.js';
import { SymbolModel, SimulationResultModel, SimulationConfigModel } from '../database/models.js';
import { NewListingScalperStrategy } from './strategies/newListingScalper.js';
import { TrailingStopLoss } from './strategies/trailingStopLoss.js';
import { validateConfig, validateMarketData } from '../utils/validators.js';
import { calculateProfitLoss, calculateCommission, calculateLiquidity, calculateVolatility } from '../utils/calculations.js';
import logger from '../utils/logger.js';

export class TradingSimulator {
  constructor(config) {
    // Валідація конфігурації
    const configValidation = validateConfig(config);
    if (!configValidation.isValid) {
      throw new Error(`Invalid configuration: ${configValidation.errors.join(', ')}`);
    }

    this.config = config;
    this.dbPromise = getDatabase();
    this.activeTrades = new Map();
    this.completedTrades = [];
    this.currentBalance = parseFloat(process.env.INITIAL_BALANCE_USDT) || 10000;
    this.initialBalance = this.currentBalance;
    this.cooldownMap = new Map();
    
    // Ініціалізація стратегій
    this.strategy = new NewListingScalperStrategy(config);
    this.trailingStopLoss = new TrailingStopLoss(config);
    
    // Ініціалізація моделей БД
    this.symbolModel = new SymbolModel();
    this.resultModel = new SimulationResultModel();
    this.configModel = new SimulationConfigModel();
    
    // Статистика
    this.stats = {
      totalTrades: 0,
      profitableTrades: 0,
      losingTrades: 0,
      timeoutTrades: 0,
      trailingStopTrades: 0,
      takeProfitTrades: 0,
      stopLossTrades: 0,
      totalVolume: 0,
      totalCommissions: 0,
      maxDrawdown: 0,
      currentDrawdown: 0,
      peakBalance: this.currentBalance
    };
    
    // Налаштування симуляції
    this.startTime = Date.now();
    this.processedListings = 0;
    this.skippedListings = 0;
  }

  /**
   * Запуск симуляції
   */
  async runSimulation(daysBack = 180) {
    logger.info(`Starting simulation: ${this.config.name}`);
    logger.info(`Initial balance: ${this.initialBalance} USDT`);
    
    try {
      // Збереження конфігурації в БД
      const configId = await this.saveConfiguration();
      
      // Отримання даних для симуляції
      const newListings = await this.getNewListingsWithData(daysBack);
      logger.info(`Found ${newListings.length} new listings to simulate`);
      
      if (newListings.length === 0) {
        logger.warn('No new listings found for simulation');
        return this.generateResults(configId);
      }
      
      // Сортування за датою лістингу
      newListings.sort((a, b) => a.listing_date - b.listing_date);
      
      // Обробка кожного лістингу
      for (let i = 0; i < newListings.length; i++) {
        const listing = newListings[i];
        
        try {
          const result = await this.processListing(listing, configId);
          
          if (i % 50 === 0 || i === newListings.length - 1) {
            const progress = ((i + 1) / newListings.length * 100).toFixed(1);
            logger.info(`Simulation progress: ${progress}% (${i + 1}/${newListings.length})`);
          }
          
        } catch (error) {
          logger.error(`Error processing listing ${listing.symbol}: ${error.message}`);
          this.skippedListings++;
        }
      }
      
      // Закриття активних угод
      await this.closeAllActiveTrades('simulation_ended', configId);
      
      // Генерація результатів
      const results = await this.generateResults(configId);
      
      logger.info('Simulation completed successfully');
      return results;
      
    } catch (error) {
      logger.error(`Simulation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Збереження конфігурації в БД
   */
  async saveConfiguration() {
    try {
      return this.configModel.create(this.config);
    } catch (error) {
      logger.error(`Failed to save configuration: ${error.message}`);
      throw error;
    }
  }

  /**
   * Отримання нових лістингів з даними
   */
  async getNewListingsWithData(daysBack) {
    const cutoffDate = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    
    try {
      const query = `
        SELECT 
          s.id as symbol_id,
          s.symbol,
          la.listing_date,
          COUNT(hk.id) as klines_count,
          MIN(hk.open_time) as first_kline,
          MAX(hk.close_time) as last_kline
        FROM symbols s
        JOIN listing_analysis la ON s.id = la.symbol_id
        LEFT JOIN historical_klines hk ON s.id = hk.symbol_id
        WHERE la.data_status = 'analyzed'
        AND la.listing_date >= ?
        GROUP BY s.id, s.symbol, la.listing_date
        HAVING klines_count > 5
        ORDER BY la.listing_date ASC
      `;
      
      const db = await this.dbPromise;
      return db.all(query, cutoffDate);
      
    } catch (error) {
      logger.error(`Failed to fetch new listings: ${error.message}`);
      throw error;
    }
  }

  /**
   * Обробка одного лістингу
   */
  async processListing(listing, configId) {
    const { symbol_id, symbol, listing_date } = listing;
    
    try {
      // Отримання історичних даних
      const marketData = await this.getMarketDataForListing(symbol_id, symbol, listing_date);
      
      if (!marketData) {
        this.skippedListings++;
        return { processed: false, reason: 'no_market_data' };
      }
      
      // Валідація ринкових даних
      const validation = validateMarketData(marketData);
      if (!validation.isValid) {
        logger.debug(`Invalid market data for ${symbol}: ${validation.errors.join(', ')}`);
        this.skippedListings++;
        return { processed: false, reason: 'invalid_data', errors: validation.errors };
      }
      
      // Перевірка умов входу
      const entryConditions = await this.strategy.checkEntryConditions(marketData);
      
      if (!entryConditions.shouldEnter) {
        this.skippedListings++;
        return { processed: false, reason: entryConditions.reason };
      }
      
      // Перевірка балансу
      if (this.currentBalance < this.config.buyAmountUsdt) {
        this.skippedListings++;
        return { processed: false, reason: 'insufficient_balance' };
      }
      
      // Виконання торгівлі
      const tradeResult = await this.executeTrade(marketData, configId);
      this.processedListings++;
      
      return { processed: true, trade: tradeResult };
      
    } catch (error) {
      logger.error(`Error processing listing ${symbol}: ${error.message}`);
      this.skippedListings++;
      return { processed: false, reason: 'error', error: error.message };
    }
  }

  /**
   * Отримання ринкових даних для лістингу
   */
  async getMarketDataForListing(symbolId, symbol, listingDate) {
    try {
      // Отримання історичних klines
      const klinesQuery = `
        SELECT open_time, close_time, open_price, high_price, low_price, close_price, volume, quote_asset_volume
        FROM historical_klines
        WHERE symbol_id = ? 
        AND open_time >= ? 
        AND open_time <= ?
        ORDER BY open_time ASC 
        LIMIT 20
      `;
      
      const startTime = listingDate;
      const endTime = listingDate + (20 * 60 * 1000); // 20 хвилин після лістингу
      
      const db = await this.dbPromise;
      const klines = await db.all(klinesQuery, symbolId, startTime, endTime);
      
      if (klines.length < 3) {
        return null;
      }
      
      // Створення ticker з останньої свічки
      const lastKline = klines[klines.length - 1];
      const ticker = {
        symbol,
        price: lastKline.close_price,
        volume: lastKline.volume,
        priceChangePercent: this.calculatePriceChange(klines)
      };
      
      // Створення простого order book (симуляція)
      const currentPrice = parseFloat(lastKline.close_price);
      const orderBook = this.generateSimulatedOrderBook(currentPrice);
      
      return {
        symbol,
        ticker,
        orderBook,
        klines: klines.map(k => ({
          open_price: k.open_price,
          high_price: k.high_price,
          low_price: k.low_price,
          close_price: k.close_price,
          volume: k.volume,
          quote_asset_volume: k.quote_asset_volume,
          openTime: k.open_time,
          closeTime: k.close_time
        })),
        listingDate,
        currentTime: endTime,
        symbolId
      };
      
    } catch (error) {
      logger.error(`Failed to get market data for ${symbol}: ${error.message}`);
      return null;
    }
  }

  /**
   * Розрахунок зміни ціни
   */
  calculatePriceChange(klines) {
    if (klines.length < 2) return '0.00';
    
    const firstPrice = parseFloat(klines[0].open_price);
    const lastPrice = parseFloat(klines[klines.length - 1].close_price);
    const change = ((lastPrice - firstPrice) / firstPrice) * 100;
    
    return change.toFixed(2);
  }

  /**
   * Генерація симульованого order book
   */
  generateSimulatedOrderBook(currentPrice) {
    const bids = [];
    const asks = [];
    const spread = currentPrice * 0.001; // 0.1% спред
    
    // Генерація bids (ціни нижче поточної)
    for (let i = 0; i < 10; i++) {
      const price = currentPrice - spread - (i * spread * 0.1);
      const quantity = Math.random() * 1000 + 100;
      bids.push([price.toFixed(8), quantity.toFixed(8)]);
    }
    
    // Генерація asks (ціни вище поточної)
    for (let i = 0; i < 10; i++) {
      const price = currentPrice + spread + (i * spread * 0.1);
      const quantity = Math.random() * 1000 + 100;
      asks.push([price.toFixed(8), quantity.toFixed(8)]);
    }
    
    return { bids, asks };
  }

  /**
   * Виконання торгівлі
   */
  async executeTrade(marketData, configId) {
    const { symbol, ticker, symbolId } = marketData;
    const entryPrice = parseFloat(ticker.price);
    const quantity = this.config.buyAmountUsdt / entryPrice;
    const entryTime = Date.now();
    
    // Розрахунок комісій
    const buyCommission = calculateCommission(this.config.buyAmountUsdt, this.config.binanceFeePercent);
    
    // Створення угоди
    const trade = {
      id: `TRADE_${symbol}_${entryTime}`,
      configId,
      symbolId,
      symbol,
      entryPrice,
      quantity,
      entryTime,
      buyCommission,
      maxPrice: entryPrice,
      minPrice: entryPrice,
      status: 'ACTIVE'
    };
    
    // Додавання в активні угоди
    this.activeTrades.set(symbol, trade);
    
    // Оновлення балансу
    this.currentBalance -= this.config.buyAmountUsdt;
    this.stats.totalVolume += this.config.buyAmountUsdt;
    this.stats.totalCommissions += buyCommission;
    
    // Симуляція руху ціни та закриття угоди
    await this.simulateTradeExecution(trade, marketData);
    
    return trade;
  }

  /**
   * Симуляція виконання угоди
   */
  async simulateTradeExecution(trade, marketData) {
    const { klines } = marketData;
    const exitConditions = this.strategy.getExitConditions(trade.entryPrice, this.config);
    
    // Симуляція руху ціни по klines
    for (let i = 1; i < klines.length; i++) {
      const kline = klines[i];
      const high = parseFloat(kline.high);
      const low = parseFloat(kline.low);
      const close = parseFloat(kline.close);
      
      // Оновлення мін/макс цін
      trade.maxPrice = Math.max(trade.maxPrice, high);
      trade.minPrice = Math.min(trade.minPrice, low);
      
      // Перевірка trailing stop
      if (this.config.trailingStopEnabled) {
        const trailingResult = this.trailingStopLoss.update(trade, close);
        if (trailingResult.shouldExit) {
          await this.closeTrade(trade, 'trailing_stop', trailingResult.exitPrice);
          return;
        }
      }
      
      // Перевірка take profit
      if (high >= exitConditions.takeProfitPrice) {
        await this.closeTrade(trade, 'take_profit', exitConditions.takeProfitPrice);
        return;
      }
      
      // Перевірка stop loss
      if (low <= exitConditions.stopLossPrice) {
        await this.closeTrade(trade, 'stop_loss', exitConditions.stopLossPrice);
        return;
      }
    }
    
    // Якщо угода не закрилася, закриваємо за останньою ціною
    const lastPrice = parseFloat(klines[klines.length - 1].close);
    await this.closeTrade(trade, 'timeout', lastPrice);
  }

  /**
   * Закриття угоди
   */
  async closeTrade(trade, reason, exitPrice) {
    const sellCommission = calculateCommission(exitPrice * trade.quantity, this.config.binanceFeePercent);
    
    // Розрахунок прибутку/збитку
    const profitLoss = calculateProfitLoss({
      entryPrice: trade.entryPrice,
      exitPrice,
      quantity: trade.quantity,
      entryCommission: trade.buyCommission,
      exitCommission: sellCommission
    });
    
    // Оновлення угоди
    trade.exitPrice = exitPrice;
    trade.exitTime = Date.now();
    trade.exitReason = reason;
    trade.sellCommission = sellCommission;
    trade.profitLossUsdt = profitLoss.usdt;
    trade.profitLossPercent = profitLoss.percent;
    trade.status = 'CLOSED';
    
    // Видалення з активних угод
    this.activeTrades.delete(trade.symbol);
    
    // Додавання в завершені угоди
    this.completedTrades.push(trade);
    
    // Оновлення балансу
    const totalReturn = (exitPrice * trade.quantity) - sellCommission;
    this.currentBalance += totalReturn;
    
    // Оновлення статистики
    this.updateStats(trade);
    
    // Збереження в БД
    await this.saveTradeResult(trade);
    
    // Встановлення cooldown
    this.strategy.setCooldown(trade.symbol);
    
    logger.debug(`Trade closed: ${trade.symbol} - ${reason} - P&L: ${profitLoss.usdt.toFixed(2)} USDT (${profitLoss.percent.toFixed(2)}%)`);
  }

  /**
   * Збереження результату угоди в БД
   */
  async saveTradeResult(trade) {
    try {
      const result = {
        configId: trade.configId,
        symbolId: trade.symbolId,
        entryTime: trade.entryTime,
        entryPrice: trade.entryPrice,
        exitTime: trade.exitTime,
        exitPrice: trade.exitPrice,
        exitReason: trade.exitReason,
        quantity: trade.quantity,
        profitLossUsdt: trade.profitLossUsdt,
        profitLossPercent: trade.profitLossPercent,
        buyCommission: trade.buyCommission,
        sellCommission: trade.sellCommission,
        maxPriceReached: trade.maxPrice,
        minPriceReached: trade.minPrice,
        trailingStopTriggered: trade.exitReason === 'trailing_stop'
      };
      
      await this.resultModel.create(result);
      
    } catch (error) {
      logger.error(`Failed to save trade result: ${error.message}`);
    }
  }

  /**
   * Закриття всіх активних угод
   */
  async closeAllActiveTrades(reason, configId) {
    const trades = Array.from(this.activeTrades.values());
    
    for (const trade of trades) {
      // Використовуємо останню відому ціну
      const exitPrice = trade.maxPrice || trade.entryPrice;
      await this.closeTrade(trade, reason, exitPrice);
    }
    
    logger.info(`Closed ${trades.length} active trades due to: ${reason}`);
  }

  /**
   * Оновлення статистики
   */
  updateStats(trade) {
    this.stats.totalTrades++;
    this.stats.totalCommissions += trade.sellCommission;
    
    // Підрахунок типів закриття
    switch (trade.exitReason) {
      case 'take_profit':
        this.stats.takeProfitTrades++;
        break;
      case 'stop_loss':
        this.stats.stopLossTrades++;
        break;
      case 'trailing_stop':
        this.stats.trailingStopTrades++;
        break;
      case 'timeout':
        this.stats.timeoutTrades++;
        break;
    }
    
    // Підрахунок прибуткових/збиткових угод
    if (trade.profitLossUsdt > 0) {
      this.stats.profitableTrades++;
    } else {
      this.stats.losingTrades++;
    }
    
    // Розрахунок просадки
    if (this.currentBalance > this.stats.peakBalance) {
      this.stats.peakBalance = this.currentBalance;
      this.stats.currentDrawdown = 0;
    } else {
      this.stats.currentDrawdown = ((this.stats.peakBalance - this.currentBalance) / this.stats.peakBalance) * 100;
      this.stats.maxDrawdown = Math.max(this.stats.maxDrawdown, this.stats.currentDrawdown);
    }
  }

  /**
   * Генерація результатів симуляції
   */
  async generateResults(configId) {
    const endTime = Date.now();
    const duration = endTime - this.startTime;
    
    // Базові метрики
    const totalReturn = this.currentBalance - this.initialBalance;
    const roiPercent = (totalReturn / this.initialBalance) * 100;
    const winRate = this.stats.totalTrades > 0 ? (this.stats.profitableTrades / this.stats.totalTrades) * 100 : 0;
    
    // Додаткові метрики
    const avgTradeReturn = this.stats.totalTrades > 0 ? totalReturn / this.stats.totalTrades : 0;
    const avgWinningTrade = this.calculateAvgWinningTrade();
    const avgLosingTrade = this.calculateAvgLosingTrade();
    const profitFactor = this.calculateProfitFactor();
    const sharpeRatio = this.calculateSharpeRatio();
    const maxConsecutiveLosses = this.calculateMaxConsecutiveLosses();
    
    // Детальна статистика по типах закриття
    const exitReasonStats = {
      takeProfit: this.stats.takeProfitTrades,
      stopLoss: this.stats.stopLossTrades,
      trailingStop: this.stats.trailingStopTrades,
      timeout: this.stats.timeoutTrades
    };
    
    // Підсумок
    const summary = {
      configId,
      configName: this.config.name,
      
      // Основні метрики
      initialBalance: this.initialBalance,
      finalBalance: this.currentBalance,
      totalReturn: totalReturn,
      roiPercent: parseFloat(roiPercent.toFixed(2)),
      
      // Торгові метрики
      totalTrades: this.stats.totalTrades,
      profitableTrades: this.stats.profitableTrades,
      losingTrades: this.stats.losingTrades,
      winRate: parseFloat(winRate.toFixed(2)),
      
      // Середні значення
      avgTradeReturn: parseFloat(avgTradeReturn.toFixed(2)),
      avgWinningTrade: parseFloat(avgWinningTrade.toFixed(2)),
      avgLosingTrade: parseFloat(avgLosingTrade.toFixed(2)),
      
      // Ризикові метрики
      maxDrawdown: parseFloat(this.stats.maxDrawdown.toFixed(2)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      sharpeRatio: parseFloat(sharpeRatio.toFixed(2)),
      maxConsecutiveLosses,
      
      // Комісії та об'єми
      totalVolume: parseFloat(this.stats.totalVolume.toFixed(2)),
      totalCommissions: parseFloat(this.stats.totalCommissions.toFixed(2)),
      
      // Статистика виходів
      exitReasonStats,
      
      // Технічні метрики
      simulationDuration: duration,
      processedListings: this.processedListings,
      skippedListings: this.skippedListings,
      averageTradeTime: this.calculateAverageTradeTime()
    };
    
    // Збереження підсумку в БД
    await this.saveSimulationSummary(summary);
    
    return {
      summary,
      trades: this.completedTrades,
      config: this.config,
      stats: this.stats
    };
  }

  /**
   * Розрахунок середнього прибутку від прибуткових угод
   */
  calculateAvgWinningTrade() {
    const winningTrades = this.completedTrades.filter(t => t.profitLossUsdt > 0);
    if (winningTrades.length === 0) return 0;
    
    const totalWinnings = winningTrades.reduce((sum, t) => sum + t.profitLossUsdt, 0);
    return totalWinnings / winningTrades.length;
  }

  /**
   * Розрахунок середнього збитку від збиткових угод
   */
  calculateAvgLosingTrade() {
    const losingTrades = this.completedTrades.filter(t => t.profitLossUsdt < 0);
    if (losingTrades.length === 0) return 0;
    
    const totalLosses = losingTrades.reduce((sum, t) => sum + Math.abs(t.profitLossUsdt), 0);
    return totalLosses / losingTrades.length;
  }

  /**
   * Розрахунок profit factor
   */
  calculateProfitFactor() {
    const totalWinnings = this.completedTrades
      .filter(t => t.profitLossUsdt > 0)
      .reduce((sum, t) => sum + t.profitLossUsdt, 0);
      
    const totalLosses = Math.abs(this.completedTrades
      .filter(t => t.profitLossUsdt < 0)
      .reduce((sum, t) => sum + t.profitLossUsdt, 0));
    
    return totalLosses > 0 ? totalWinnings / totalLosses : 0;
  }

  /**
   * Розрахунок Sharpe ratio (спрощений)
   */
  calculateSharpeRatio() {
    if (this.completedTrades.length < 2) return 0;
    
    const returns = this.completedTrades.map(t => t.profitLossPercent);
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    return stdDev > 0 ? avgReturn / stdDev : 0;
  }

  /**
   * Розрахунок максимальної кількості послідовних збитків
   */
  calculateMaxConsecutiveLosses() {
    let maxConsecutive = 0;
    let currentConsecutive = 0;
    
    for (const trade of this.completedTrades) {
      if (trade.profitLossUsdt < 0) {
        currentConsecutive++;
        maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
      } else {
        currentConsecutive = 0;
      }
    }
    
    return maxConsecutive;
  }

  /**
   * Розрахунок середнього часу угоди
   */
  calculateAverageTradeTime() {
    if (this.completedTrades.length === 0) return 0;
    
    const totalTime = this.completedTrades.reduce((sum, trade) => {
      return sum + (trade.exitTime - trade.entryTime);
    }, 0);
    
    return Math.round(totalTime / this.completedTrades.length / 1000 / 60); // в хвилинах
  }

  /**
   * Збереження підсумку симуляції
   */
  async saveSimulationSummary(summary) {
    try {
      const query = `
        INSERT OR REPLACE INTO simulation_summary (
          config_id, total_trades, profitable_trades, losing_trades,
          win_rate_percent, roi_percent, max_drawdown_percent,
          total_volume_usdt, total_commissions_usdt, profit_factor,
          sharpe_ratio, avg_trade_return_usdt, simulation_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      
      const db = await this.dbPromise;
      await db.run(
        summary.configId,
        summary.totalTrades,
        summary.profitableTrades,
        summary.losingTrades,
        summary.winRate,
        summary.roiPercent,
        summary.maxDrawdown,
        summary.totalVolume,
        summary.totalCommissions,
        summary.profitFactor,
        summary.sharpeRatio,
        summary.avgTradeReturn,
        Date.now()
      );
      
      logger.info('Simulation summary saved to database');
      
    } catch (error) {
      logger.error(`Failed to save simulation summary: ${error.message}`);
    }
  }

  /**
   * Отримання детальної статистики
   */
  getDetailedStats() {
    return {
      ...this.stats,
      completedTrades: this.completedTrades.length,
      activeTrades: this.activeTrades.size,
      currentBalance: this.currentBalance,
      totalReturn: this.currentBalance - this.initialBalance,
      roiPercent: ((this.currentBalance - this.initialBalance) / this.initialBalance) * 100
    };
  }

  /**
   * Експорт даних симуляції
   */
  exportData() {
    return {
      config: this.config,
      summary: this.getDetailedStats(),
      trades: this.completedTrades.map(trade => ({
        symbol: trade.symbol,
        entryTime: new Date(trade.entryTime).toISOString(),
        exitTime: new Date(trade.exitTime).toISOString(),
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        quantity: trade.quantity,
        profitLossUsdt: trade.profitLossUsdt,
        profitLossPercent: trade.profitLossPercent,
        exitReason: trade.exitReason,
        duration: trade.exitTime - trade.entryTime
      })),
      metadata: {
        simulationDate: new Date(this.startTime).toISOString(),
        duration: Date.now() - this.startTime,
        processedListings: this.processedListings,
        skippedListings: this.skippedListings
      }
    };
  }

  /**
   * Скидання стану симулятора
   */
  reset() {
    this.activeTrades.clear();
    this.completedTrades = [];
    this.currentBalance = this.initialBalance;
    this.cooldownMap.clear();
    this.strategy.reset();
    
    // Скидання статистики
    this.stats = {
      totalTrades: 0,
      profitableTrades: 0,
      losingTrades: 0,
      timeoutTrades: 0,
      trailingStopTrades: 0,
      takeProfitTrades: 0,
      stopLossTrades: 0,
      totalVolume: 0,
      totalCommissions: 0,
      maxDrawdown: 0,
      currentDrawdown: 0,
      peakBalance: this.currentBalance
    };
    
    this.startTime = Date.now();
    this.processedListings = 0;
    this.skippedListings = 0;
  }
}

export default TradingSimulator;