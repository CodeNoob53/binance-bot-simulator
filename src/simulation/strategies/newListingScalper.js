import logger from '../../utils/logger.js';

/**
 * ФОРСОВАНА СТРАТЕГІЯ ДЛЯ ТЕСТУВАННЯ - ЗАВЖДИ ВХОДИТЬ В УГОДИ
 * Створена для повного тестування всіх параметрів торгівлі
 */
export class NewListingScalperStrategy {
  constructor(config) {
    this.config = config;
    this.name = 'NewListingScalper';
    this.cooldowns = new Map();
    this.activeTrades = new Map();
    this.simulationMode = true; // ЗАВЖДИ в режимі симуляції
    
    logger.info(`Strategy initialized: ${this.name} (FORCE ENTRY MODE)`);
  }

  /**
   * ЗАВЖДИ ДОЗВОЛЯЄМО ТОРГІВЛЮ - головний метод для тестування
   */
  async checkEntryConditions(marketData) {
    const { symbol, ticker, klines } = marketData;
    
    try {
      // Збираємо аналітичні дані без блокування торгівлі
      const analytics = this.collectAnalytics(marketData);
      
      // Логуємо аналітику для подальшого використання
      if (analytics.warnings.length > 0) {
        logger.debug(`[ANALYTICS] ${symbol}: ${analytics.warnings.join(', ')}`);
      }

      // ЗАВЖДИ ПОВЕРТАЄМО TRUE для тестування
      return { 
        shouldEnter: true, 
        reason: 'FORCED_ENTRY_FOR_TESTING',
        entryPrice: parseFloat(ticker.price),
        analytics: analytics,
        confidence: 1.0
      };
      
    } catch (error) {
      logger.error(`Strategy error for ${symbol}: ${error.message}`);
      
      // НАВІТЬ ПРИ ПОМИЛЦІ ДОЗВОЛЯЄМО ТОРГІВЛЮ
      return { 
        shouldEnter: true, 
        reason: 'FORCED_ENTRY_DESPITE_ERROR',
        entryPrice: parseFloat(ticker.price) || 1.0,
        error: error.message
      };
    }
  }

  /**
   * Збір аналітичних даних (без блокування торгівлі)
   */
  collectAnalytics(marketData) {
    const { symbol, ticker, orderBook, klines } = marketData;
    const warnings = [];
    
    const analytics = {
      symbol,
      timestamp: Date.now(),
      price: parseFloat(ticker.price) || 0,
      volume: parseFloat(ticker.volume) || 0,
      warnings: []
    };

    try {
      // Аналіз ліквідності (без блокування)
      const liquidity = this.analyzeLiquidity(orderBook, ticker);
      analytics.liquidity = liquidity.total;
      analytics.estimatedLiquidity = liquidity.estimated;
      
      if (liquidity.total < 5000) {
        warnings.push(`low_liquidity_${liquidity.total.toFixed(0)}`);
      }

      // Аналіз волатільності (без блокування)
      const volatility = this.analyzeVolatility(klines);
      analytics.volatility = volatility;
      
      if (volatility < 1.0) {
        warnings.push(`low_volatility_${volatility.toFixed(2)}`);
      }

      // Технічний аналіз (без блокування)
      const technicalSignal = this.analyzeTechnicals(klines);
      analytics.technical = technicalSignal;
      
      if (!technicalSignal.bullish) {
        warnings.push(`bearish_signal_${technicalSignal.strength}`);
      }

    } catch (error) {
      warnings.push(`analytics_error_${error.message.substring(0, 20)}`);
    }

    analytics.warnings = warnings;
    return analytics;
  }

  /**
   * Аналіз ліквідності (інформативний)
   */
  analyzeLiquidity(orderBook, ticker) {
    try {
      const price = parseFloat(ticker.price) || 1.0;
      const volume = parseFloat(ticker.volume) || 0;
      
      // Якщо є orderBook - аналізуємо його
      if (orderBook && orderBook.bids && orderBook.asks) {
        const bidLiquidity = orderBook.bids.slice(0, 5).reduce((sum, [bidPrice, quantity]) => {
          return sum + (parseFloat(bidPrice) * parseFloat(quantity));
        }, 0);

        const askLiquidity = orderBook.asks.slice(0, 5).reduce((sum, [askPrice, quantity]) => {
          return sum + (parseFloat(askPrice) * parseFloat(quantity));
        }, 0);

        return {
          total: bidLiquidity + askLiquidity,
          estimated: false,
          bidLiquidity,
          askLiquidity
        };
      }

      // Якщо немає orderBook - оцінюємо на основі об'єму
      const estimatedLiquidity = Math.max(volume * price * 0.1, 2000);
      
      return {
        total: estimatedLiquidity,
        estimated: true,
        bidLiquidity: estimatedLiquidity / 2,
        askLiquidity: estimatedLiquidity / 2
      };

    } catch (error) {
      logger.debug(`Liquidity analysis error: ${error.message}`);
      return {
        total: 5000, // Безпечне значення за замовчуванням
        estimated: true,
        error: error.message
      };
    }
  }

  /**
   * Аналіз волатільності (інформативний)
   */
  analyzeVolatility(klines) {
    try {
      if (!klines || klines.length < 2) {
        return 2.0; // За замовчуванням
      }

      const priceChanges = [];
      for (let i = 1; i < Math.min(klines.length, 10); i++) {
        const prevClose = parseFloat(klines[i-1].close);
        const currentClose = parseFloat(klines[i].close);
        
        if (prevClose > 0 && currentClose > 0) {
          const change = Math.abs((currentClose - prevClose) / prevClose) * 100;
          priceChanges.push(change);
        }
      }

      if (priceChanges.length === 0) {
        return 2.0;
      }

      return priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;

    } catch (error) {
      logger.debug(`Volatility analysis error: ${error.message}`);
      return 2.0;
    }
  }

  /**
   * Технічний аналіз (інформативний)
   */
  analyzeTechnicals(klines) {
    try {
      if (!klines || klines.length < 3) {
        return { bullish: true, strength: 'unknown', reason: 'insufficient_data' };
      }

      const recentKlines = klines.slice(-5);
      const prices = recentKlines.map(k => parseFloat(k.close));
      
      // Простий тренд-аналіз
      const firstPrice = prices[0];
      const lastPrice = prices[prices.length - 1];
      const trendChange = (lastPrice - firstPrice) / firstPrice * 100;

      const isBullish = trendChange > -2.0; // Терпимо до -2%
      const strength = Math.abs(trendChange) > 5 ? 'strong' : 'weak';

      return {
        bullish: isBullish,
        strength,
        trendChange,
        reason: isBullish ? 'uptrend_detected' : 'downtrend_detected'
      };

    } catch (error) {
      logger.debug(`Technical analysis error: ${error.message}`);
      return { bullish: true, strength: 'error', reason: 'analysis_failed' };
    }
  }

  /**
   * Методи сумісності з базовим класом
   */
  
  isNewListing(marketData) {
    // У симуляції всі лістинги вважаємо "новими"
    return true;
  }

  isOnCooldown(symbol) {
    // У симуляції cooldown відключено
    return false;
  }

  setCooldown(symbol, seconds = null) {
    // У симуляції не встановлюємо cooldown
    return;
  }

  reset() {
    this.cooldowns.clear();
    this.activeTrades.clear();
    logger.info(`${this.name}: Strategy reset`);
  }

  getStats() {
    return {
      name: this.name,
      mode: 'FORCE_ENTRY_SIMULATION',
      activeTrades: this.activeTrades.size,
      cooldowns: this.cooldowns.size
    };
  }

  getName() {
    return this.name;
  }

  // Методи для сумісності з різними версіями коду
  async analyzeMarket(marketData) {
    return this.checkEntryConditions(marketData);
  }

  async shouldEnter(marketData) {
    const conditions = await this.checkEntryConditions(marketData);
    return conditions.shouldEnter;
  }
}

export default NewListingScalperStrategy;