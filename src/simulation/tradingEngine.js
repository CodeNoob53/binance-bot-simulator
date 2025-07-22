import { EventEmitter } from 'events';
import { NewListingScalperStrategy } from './strategies/newListingScalper.js';
import { TrailingStopLoss } from './strategies/trailingStopLoss.js';
import { validateTrade, validateOrderBook, validateMarketData } from '../utils/validators.js';
import { calculateProfitLoss, calculateCommission } from '../utils/calculations.js';
import logger from '../utils/logger.js';

export class TradingEngine extends EventEmitter {
  constructor(config, apiClient) {
    super();
    this.config = config;
    this.apiClient = apiClient;
    this.activeTrades = new Map();
    this.tradeHistory = [];
    this.balance = {
      usdt: parseFloat(process.env.INITIAL_BALANCE_USDT) || 10000,
      locked: 0
    };
    
    // Ініціалізація стратегій
    this.strategy = new NewListingScalperStrategy(config);
    this.trailingStopLoss = new TrailingStopLoss(config);
    
    // Стан системи
    this.isRunning = false;
    this.stats = {
      totalTrades: 0,
      profitableTrades: 0,
      losingTrades: 0,
      totalProfit: 0,
      totalLoss: 0,
      maxDrawdown: 0,
      currentDrawdown: 0,
      peakBalance: this.balance.usdt
    };
    
    this.setupEventHandlers();
  }

  /**
   * Налаштування обробників подій
   */
  setupEventHandlers() {
    this.on('trade_opened', this.handleTradeOpened.bind(this));
    this.on('trade_closed', this.handleTradeClosed.bind(this));
    this.on('error', this.handleError.bind(this));
    this.on('balance_updated', this.handleBalanceUpdated.bind(this));
  }

  /**
   * Запуск торгового движка
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Trading engine is already running');
      return;
    }

    logger.info('Starting trading engine...');
    this.isRunning = true;
    
    try {
      // Перевірка підключення до API
      await this.validateConnection();
      
      // Завантаження поточного балансу
      await this.loadBalance();
      
      // Відновлення активних угод
      await this.restoreActiveTrades();
      
      logger.info('Trading engine started successfully');
      this.emit('engine_started');
      
    } catch (error) {
      logger.error(`Failed to start trading engine: ${error.message}`);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Зупинка торгового движка
   */
  async stop() {
    if (!this.isRunning) {
      logger.warn('Trading engine is not running');
      return;
    }

    logger.info('Stopping trading engine...');
    this.isRunning = false;
    
    try {
      // Закриваємо всі активні угоди
      await this.closeAllTrades('engine_stopped');
      
      logger.info('Trading engine stopped successfully');
      this.emit('engine_stopped');
      
    } catch (error) {
      logger.error(`Error stopping trading engine: ${error.message}`);
    }
  }

  /**
   * Обробка нового лістингу
   */
  async processNewListing(marketData) {
    if (!this.isRunning) {
      return { processed: false, reason: 'engine_not_running' };
    }

    try {
      // Валідація ринкових даних
      const validation = validateMarketData(marketData);
      if (!validation.isValid) {
        return { processed: false, reason: 'invalid_market_data', errors: validation.errors };
      }

      const { symbol } = marketData;
      
      // Перевірка чи вже торгуємо цим символом
      if (this.activeTrades.has(symbol)) {
        return { processed: false, reason: 'already_trading' };
      }

      // Перевірка умов входу
      const entryConditions = await this.strategy.checkEntryConditions(marketData);
      
      if (!entryConditions.shouldEnter) {
        logger.debug(`Entry conditions not met for ${symbol}: ${entryConditions.reason}`);
        return { processed: false, reason: entryConditions.reason, details: entryConditions };
      }

      // Перевірка балансу
      if (!this.hasEnoughBalance()) {
        return { processed: false, reason: 'insufficient_balance' };
      }

      // Виконання покупки
      const buyResult = await this.executeBuy(marketData);
      
      if (buyResult.success) {
        logger.info(`Successfully opened trade for ${symbol}`);
        return { processed: true, trade: buyResult.trade };
      } else {
        logger.error(`Failed to open trade for ${symbol}: ${buyResult.error}`);
        return { processed: false, reason: 'execution_failed', error: buyResult.error };
      }

    } catch (error) {
      logger.error(`Error processing new listing ${marketData.symbol}: ${error.message}`);
      this.emit('error', error);
      return { processed: false, reason: 'processing_error', error: error.message };
    }
  }

  /**
   * Виконання покупки
   */
  async executeBuy(marketData) {
    const { symbol, ticker, orderBook } = marketData;
    
    try {
      // Валідація orderBook
      const orderBookValidation = validateOrderBook(orderBook);
      if (!orderBookValidation.isValid) {
        throw new Error(`Invalid order book: ${orderBookValidation.errors.join(', ')}`);
      }

      const currentPrice = parseFloat(ticker.price);
      const quantity = this.config.buyAmountUsdt / currentPrice;
      
      // Створення ордеру
      const order = await this.createOrder({
        symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: quantity.toFixed(8),
        timestamp: Date.now()
      });

      if (order.success) {
        // Створення торгової позиції
        const entryCommission = calculateCommission(
          this.config.buyAmountUsdt,
          this.config.binanceFeePercent
        );

        const trade = this.createTrade({
          symbol,
          entryPrice: currentPrice,
          quantity,
          entryTime: Date.now(),
          orderId: order.orderId,
          commission: calculateCommission(this.config.buyAmountUsdt, this.config.binanceFeePercent * 100)
        });

        // Додавання в активні угоди
        this.activeTrades.set(symbol, trade);
        
        // Оновлення балансу (вартість покупки + комісія)
        this.updateBalance(-(this.config.buyAmountUsdt + entryCommission));
        
        this.emit('trade_opened', trade);
        
        return { success: true, trade };
      } else {
        throw new Error(order.error);
      }

    } catch (error) {
      logger.error(`Error executing buy for ${symbol}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Створення ордеру
   */
  async createOrder(orderParams) {
    try {
      // Валідація ордеру
      const validation = validateTrade(orderParams);
      if (!validation.isValid) {
        throw new Error(`Invalid order: ${validation.errors.join(', ')}`);
      }

      // В режимі симуляції просто повертаємо успішний результат
      if (this.config.simulationMode) {
        return {
          success: true,
          orderId: `SIM_${Date.now()}`,
          price: orderParams.price || 0,
          quantity: orderParams.quantity
        };
      }

      // Реальне виконання через API
      const result = await this.apiClient.order(orderParams);
      
      return {
        success: true,
        orderId: result.orderId,
        price: result.fills[0]?.price || result.price,
        quantity: result.executedQty
      };

    } catch (error) {
      logger.error(`Order creation failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Створення торгової позиції
   */
  createTrade(params) {
    const exitConditions = this.strategy.getExitConditions(params.entryPrice, this.config);
    
    return {
      id: `TRADE_${Date.now()}`,
      symbol: params.symbol,
      entryPrice: params.entryPrice,
      quantity: params.quantity,
      entryTime: params.entryTime,
      orderId: params.orderId,
      commission: params.commission,
      status: 'ACTIVE',
      exitConditions,
      maxPrice: params.entryPrice,
      minPrice: params.entryPrice,
      trailingStopPrice: null,
      trailingStopActivated: false
    };
  }

  /**
   * Оновлення активних угод
   */
  async updateActiveTrades(priceUpdates) {
    if (this.activeTrades.size === 0) return;

    for (const [symbol, trade] of this.activeTrades) {
      const priceData = priceUpdates[symbol];
      if (!priceData) continue;

      try {
        await this.updateTrade(trade, priceData);
      } catch (error) {
        logger.error(`Error updating trade for ${symbol}: ${error.message}`);
      }
    }
  }

  /**
   * Оновлення конкретної угоди
   */
  async updateTrade(trade, priceData) {
    const currentPrice = parseFloat(priceData.price);
    
    // Оновлення мін/макс цін
    trade.maxPrice = Math.max(trade.maxPrice, currentPrice);
    trade.minPrice = Math.min(trade.minPrice, currentPrice);

    // Перевірка trailing stop
    if (trade.exitConditions.trailingStopEnabled) {
      const trailingResult = this.trailingStopLoss.update(trade, currentPrice);
      
      if (trailingResult.shouldExit) {
        await this.closeTrade(trade, 'trailing_stop', currentPrice);
        return;
      }
    }

    // Перевірка take profit
    if (currentPrice >= trade.exitConditions.takeProfitPrice) {
      await this.closeTrade(trade, 'take_profit', currentPrice);
      return;
    }

    // Перевірка stop loss
    if (currentPrice <= trade.exitConditions.stopLossPrice) {
      await this.closeTrade(trade, 'stop_loss', currentPrice);
      return;
    }

    // Перевірка таймауту (якщо налаштовано)
    if (this.config.maxTradeTimeMinutes) {
      const tradeAge = (Date.now() - trade.entryTime) / (1000 * 60);
      if (tradeAge > this.config.maxTradeTimeMinutes) {
        await this.closeTrade(trade, 'timeout', currentPrice);
        return;
      }
    }
  }

  /**
   * Закриття угоди
   */
  async closeTrade(trade, reason, exitPrice) {
    try {
      // Виконання ордеру на продаж
      const sellResult = await this.createOrder({
        symbol: trade.symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: trade.quantity.toFixed(8)
      });

      if (sellResult.success) {
        // Розрахунок прибутку/збитку
        const exitCommission = calculateCommission(
          exitPrice * trade.quantity,
          this.config.binanceFeePercent * 100
        );
        
        const profitLoss = calculateProfitLoss({
          entryPrice: trade.entryPrice,
          exitPrice,
          quantity: trade.quantity,
          entryCommission: trade.commission,
          exitCommission
        });

        // Оновлення угоди
        trade.exitPrice = exitPrice;
        trade.exitTime = Date.now();
        trade.exitReason = reason;
        trade.profitLossUsdt = profitLoss.usdt;
        trade.profitLossPercent = profitLoss.percent;
        trade.exitCommission = exitCommission;
        trade.status = 'CLOSED';

        // Видалення з активних угод
        this.activeTrades.delete(trade.symbol);
        
        // Додавання в історію
        this.tradeHistory.push(trade);
        
        // Оновлення балансу
        const totalReturn = (exitPrice * trade.quantity) - exitCommission;
        this.updateBalance(totalReturn);
        
        // Оновлення статистики
        this.updateStats(trade);
        
        this.emit('trade_closed', trade);
        
        logger.info(`Trade closed: ${trade.symbol} - ${reason} - P&L: ${profitLoss.usdt.toFixed(2)} USDT (${profitLoss.percent.toFixed(2)}%)`);

      } else {
        logger.error(`Failed to close trade for ${trade.symbol}: ${sellResult.error}`);
      }

    } catch (error) {
      logger.error(`Error closing trade for ${trade.symbol}: ${error.message}`);
      this.emit('error', error);
    }
  }

  /**
   * Закриття всіх активних угод
   */
  async closeAllTrades(reason = 'manual_close') {
    const trades = Array.from(this.activeTrades.values());
    
    for (const trade of trades) {
      // В режимі симуляції використовуємо останню ціну
      const currentPrice = trade.maxPrice; // Спрощено
      await this.closeTrade(trade, reason, currentPrice);
    }
  }

  /**
   * Перевірка достатності балансу
   */
  hasEnoughBalance() {
    const availableBalance = this.balance.usdt - this.balance.locked;
    return availableBalance >= this.config.buyAmountUsdt;
  }

  /**
   * Оновлення балансу
   */
  updateBalance(amount) {
    this.balance.usdt += amount;
    
    // Оновлення піку та просадки
    if (this.balance.usdt > this.stats.peakBalance) {
      this.stats.peakBalance = this.balance.usdt;
      this.stats.currentDrawdown = 0;
    } else {
      this.stats.currentDrawdown = ((this.stats.peakBalance - this.balance.usdt) / this.stats.peakBalance) * 100;
      this.stats.maxDrawdown = Math.max(this.stats.maxDrawdown, this.stats.currentDrawdown);
    }
    
    this.emit('balance_updated', this.balance);
  }

  /**
   * Оновлення статистики
   */
  updateStats(trade) {
    this.stats.totalTrades++;
    
    if (trade.profitLossUsdt > 0) {
      this.stats.profitableTrades++;
      this.stats.totalProfit += trade.profitLossUsdt;
    } else {
      this.stats.losingTrades++;
      this.stats.totalLoss += Math.abs(trade.profitLossUsdt);
    }
  }

  /**
   * Валідація підключення
   */
  async validateConnection() {
    if (this.config.simulationMode) {
      logger.info('Running in simulation mode - API connection validation skipped');
      return;
    }

    try {
      await this.apiClient.ping();
      logger.info('API connection validated successfully');
    } catch (error) {
      throw new Error(`API connection failed: ${error.message}`);
    }
  }

  /**
   * Завантаження балансу
   */
  async loadBalance() {
    if (this.config.simulationMode) {
      logger.info(`Starting with simulated balance: ${this.balance.usdt} USDT`);
      return;
    }

    try {
      const account = await this.apiClient.balance();
      const usdtBalance = account.balances.find(b => b.asset === 'USDT');
      
      if (usdtBalance) {
        this.balance.usdt = parseFloat(usdtBalance.free);
        this.balance.locked = parseFloat(usdtBalance.locked);
        this.stats.peakBalance = this.balance.usdt;
        
        logger.info(`Loaded balance: ${this.balance.usdt} USDT`);
      }
    } catch (error) {
      throw new Error(`Failed to load balance: ${error.message}`);
    }
  }

  /**
   * Відновлення активних угод
   */
  async restoreActiveTrades() {
    // В реальній реалізації тут можна завантажувати угоди з БД
    logger.info('No active trades to restore');
  }

  /**
   * Обробники подій
   */
  handleTradeOpened(trade) {
    logger.info(`Trade opened: ${trade.symbol} at ${trade.entryPrice} USDT`);
  }

  handleTradeClosed(trade) {
    logger.info(`Trade closed: ${trade.symbol} - ${trade.exitReason}`);
  }

  handleError(error) {
    logger.error(`Trading engine error: ${error.message}`);
  }

  handleBalanceUpdated(balance) {
    logger.debug(`Balance updated: ${balance.usdt.toFixed(2)} USDT`);
  }

  /**
   * Отримання статистики
   */
  getStats() {
    const winRate = this.stats.totalTrades > 0 
      ? (this.stats.profitableTrades / this.stats.totalTrades) * 100 
      : 0;

    const netProfit = this.stats.totalProfit - this.stats.totalLoss;
    const roi = ((this.balance.usdt - (parseFloat(process.env.INITIAL_BALANCE_USDT) || 10000)) / (parseFloat(process.env.INITIAL_BALANCE_USDT) || 10000)) * 100;

    return {
      ...this.stats,
      winRate: winRate.toFixed(2),
      netProfit: netProfit.toFixed(2),
      roi: roi.toFixed(2),
      currentBalance: this.balance.usdt.toFixed(2),
      activeTrades: this.activeTrades.size,
      tradeHistory: this.tradeHistory.length
    };
  }

  /**
   * Отримання активних угод
   */
  getActiveTrades() {
    return Array.from(this.activeTrades.values());
  }

  /**
   * Отримання історії угод
   */
  getTradeHistory() {
    return this.tradeHistory;
  }
}