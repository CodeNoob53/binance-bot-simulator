import { BaseStrategy } from './baseStrategy.js';
import logger from '../../utils/logger.js';

export class NewListingScalperStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.name = 'NewListingScalper';
    this.cooldowns = new Map();
    this.liquidityThreshold = config.minLiquidityUsdt || 10000;
  }
  
  /**
   * Перевірка умов входу для нового лістингу
   */
  async checkEntryConditions(marketData) {
    // 1. Перевірка що це новий лістинг (перша хвилина торгів)
    if (!this.isNewListing(marketData)) {
      return { shouldEnter: false, reason: 'not_new_listing' };
    }
    
    // 2. Перевірка cooldown
    if (this.isOnCooldown(marketData.symbol)) {
      return { shouldEnter: false, reason: 'cooldown_active' };
    }
    
    // 3. Перевірка ліміту відкритих позицій
    if (this.activeTrades.size >= this.config.maxOpenTrades) {
      return { shouldEnter: false, reason: 'max_trades_reached' };
    }
    
    // 4. Перевірка ліквідності
    const liquidity = this.calculateLiquidity(marketData);
    if (liquidity < this.liquidityThreshold) {
      return { shouldEnter: false, reason: 'insufficient_liquidity', liquidity };
    }
    
    // 5. Перевірка волатильності (опціонально)
    const volatility = this.calculateVolatility(marketData);
    if (volatility < 0.01) { // Мінімум 1% волатильність
      return { shouldEnter: false, reason: 'low_volatility', volatility };
    }
    
    return { shouldEnter: true, reason: 'all_conditions_met' };
  }
  
  /**
   * Розрахунок параметрів позиції з урахуванням специфіки нових лістингів
   */
  async calculatePositionParameters(marketData) {
    const baseParams = await super.calculatePositionParameters(marketData);
    
    // Адаптивні параметри на основі початкової волатильності
    const volatility = this.calculateVolatility(marketData);
    const liquidityFactor = this.calculateLiquidityFactor(marketData);
    
    // Коригування TP/SL на основі ринкових умов
    let tpMultiplier = 1.0;
    let slMultiplier = 1.0;
    
    // Висока волатильність = ширші цілі
    if (volatility > 0.05) { // > 5%
      tpMultiplier = 1.2;
      slMultiplier = 1.1;
    } else if (volatility < 0.02) { // < 2%
      tpMultiplier = 0.8;
      slMultiplier = 0.9;
    }
    
    // Низька ліквідність = консервативніші цілі
    if (liquidityFactor < 0.5) {
      tpMultiplier *= 0.8;
      slMultiplier *= 0.9;
    }
    
    const adjustedTpPercent = this.config.takeProfitPercent * tpMultiplier;
    const adjustedSlPercent = this.config.stopLossPercent * slMultiplier;
    
    const feeAdjustment = 2 * this.config.binanceFeePercent;
    
    return {
      ...baseParams,
      tpPrice: baseParams.entryPrice * (1 + adjustedTpPercent + feeAdjustment),
      slPrice: baseParams.entryPrice * (1 - adjustedSlPercent - feeAdjustment),
      metadata: {
        volatility,
        liquidityFactor,
        tpMultiplier,
        slMultiplier
      }
    };
  }
  
  /**
   * Специфічні умови виходу для скальпінгу
   */
  async checkExitConditions(trade, marketData) {
    // Базові умови виходу
    const baseExit = await super.checkExitConditions(trade, marketData);
    if (baseExit.shouldExit) {
      return baseExit;
    }
    
    // Додаткові умови для скальпінгу
    
    // 1. Швидкий вихід при різкому падінні об'єму
    const volumeDropThreshold = 0.2; // 80% падіння об'єму
    if (this.hasVolumeDropped(trade, marketData, volumeDropThreshold)) {
      return {
        shouldExit: true,
        exitPrice: marketData.price,
        reason: 'volume_drop'
      };
    }
    
    // 2. Вихід при стагнації ціни
    if (this.isPriceStagnant(trade, marketData)) {
      return {
        shouldExit: true,
        exitPrice: marketData.price,
        reason: 'price_stagnation'
      };
    }
    
    return { shouldExit: false };
  }
  
  /**
   * Перевірка чи це новий лістинг
   */
  isNewListing(marketData) {
    // В симуляції вважаємо новим лістингом перші 5 хвилин
    return marketData.isFirstKline || marketData.minutesSinceListing < 5;
  }
  
  /**
   * Перевірка cooldown для символу
   */
  isOnCooldown(symbol) {
    const cooldownEnd = this.cooldowns.get(symbol);
    return cooldownEnd && Date.now() < cooldownEnd;
  }
  
  /**
   * Встановлення cooldown після торгівлі
   */
  setCooldown(symbol) {
    const cooldownEnd = Date.now() + (this.config.cooldownSeconds * 1000);
    this.cooldowns.set(symbol, cooldownEnd);
  }
  
  /**
   * Розрахунок ліквідності на основі об'єму
   */
  calculateLiquidity(marketData) {
    // Використовуємо quote asset volume як показник ліквідності
    return marketData.quoteAssetVolume || 0;
  }
  
  /**
   * Розрахунок фактору ліквідності (0-1)
   */
  calculateLiquidityFactor(marketData) {
    const liquidity = this.calculateLiquidity(marketData);
    const optimalLiquidity = this.liquidityThreshold * 5; // 5x мінімуму вважаємо оптимальним
    
    return Math.min(liquidity / optimalLiquidity, 1);
  }
  
  /**
   * Розрахунок волатильності
   */
  calculateVolatility(marketData) {
    if (!marketData.high || !marketData.low || marketData.low === 0) {
      return 0;
    }
    
    return (marketData.high - marketData.low) / marketData.low;
  }
  
  /**
   * Перевірка падіння об'єму
   */
  hasVolumeDropped(trade, marketData, threshold) {
    if (!trade.initialVolume) {
      trade.initialVolume = marketData.volume;
      return false;
    }
    
    const volumeRatio = marketData.volume / trade.initialVolume;
    return volumeRatio < (1 - threshold);
  }
  
  /**
   * Перевірка стагнації ціни
   */
  isPriceStagnant(trade, marketData) {
    const holdTime = marketData.timestamp - trade.entryTime;
    const priceChange = Math.abs(marketData.price - trade.entryPrice) / trade.entryPrice;
    
    // Якщо за 30 хвилин ціна змінилась менше ніж на 1%
    if (holdTime > 30 * 60 * 1000 && priceChange < 0.01) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Перевизначення входу в позицію з додатковою логікою
   */
  async enterPosition(marketData) {
    const result = await super.enterPosition(marketData);
    
    if (result.success) {
      // Встановлюємо cooldown для символу
      this.setCooldown(marketData.symbol);
      
      // Зберігаємо додаткові метадані
      result.trade.initialVolume = marketData.volume;
      result.trade.listingTime = marketData.listingTime;
    }
    
    return result;
  }
  
  /**
   * Розширені метрики
   */
  getMetrics() {
    const baseMetrics = super.getMetrics();
    
    // Додаткові метрики для скальпінгу
    const trades = Array.from(this.activeTrades.values());
    const avgHoldTime = trades.length > 0
      ? trades.reduce((sum, t) => sum + (Date.now() - t.entryTime), 0) / trades.length / 1000
      : 0;
    
    return {
      