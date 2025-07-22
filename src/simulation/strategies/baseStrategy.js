import logger from '../../utils/logger.js';
import { calculateCommission, calculateProfitLoss } from '../../utils/calculations.js';

export class BaseStrategy {
  constructor(config) {
    this.config = config;
    this.name = 'BaseStrategy';
    this.activeTrades = new Map();
    this.metrics = {
      totalSignals: 0,
      successfulEntries: 0,
      failedEntries: 0
    };
  }
  
  /**
   * Перевірка умов входу в позицію
   * @param {Object} marketData - Дані ринку
   * @returns {Object} { shouldEnter: boolean, reason: string }
   */
  async checkEntryConditions(marketData) {
    throw new Error('checkEntryConditions must be implemented by subclass');
  }
  
  /**
   * Розрахунок параметрів позиції
   * @param {Object} marketData - Дані ринку
   * @returns {Object} { quantity, entryPrice, tpPrice, slPrice }
   */
  async calculatePositionParameters(marketData) {
    const entryPrice = marketData.price;
    const quantity = this.config.buyAmountUsdt / entryPrice;
    
    // Базовий розрахунок TP/SL з урахуванням комісій
    const feeAdjustment = 2 * (this.config.binanceFeePercent / 100);
    const tpPrice = entryPrice * (1 + this.config.takeProfitPercent + feeAdjustment);
    const slPrice = entryPrice * (1 - this.config.stopLossPercent - feeAdjustment);
    
    return {
      quantity,
      entryPrice,
      tpPrice,
      slPrice
    };
  }
  
  /**
   * Перевірка умов виходу з позиції
   * @param {Object} trade - Активна угода
   * @param {Object} marketData - Поточні дані ринку
   * @returns {Object} { shouldExit: boolean, exitPrice: number, reason: string }
   */
  async checkExitConditions(trade, marketData) {
    const currentPrice = marketData.price;
    
    // Базова перевірка TP/SL
    if (marketData.high >= trade.tpPrice) {
      return {
        shouldExit: true,
        exitPrice: trade.tpPrice,
        reason: 'take_profit'
      };
    }
    
    if (marketData.low <= trade.slPrice) {
      return {
        shouldExit: true,
        exitPrice: trade.slPrice,
        reason: 'stop_loss'
      };
    }
    
    // Перевірка таймауту (48 годин)
    const holdTime = marketData.timestamp - trade.entryTime;
    if (holdTime > 48 * 60 * 60 * 1000) {
      return {
        shouldExit: true,
        exitPrice: currentPrice,
        reason: 'timeout'
      };
    }
    
    return { shouldExit: false };
  }
  
  /**
   * Виконання торгового сигналу
   * @param {Object} signal - Торговий сигнал
   * @param {Object} marketData - Дані ринку
   * @returns {Object} Результат виконання
   */
  async executeSignal(signal, marketData) {
    this.metrics.totalSignals++;
    
    try {
      if (signal.type === 'ENTRY') {
        const result = await this.enterPosition(marketData);
        if (result.success) {
          this.metrics.successfulEntries++;
        } else {
          this.metrics.failedEntries++;
        }
        return result;
        
      } else if (signal.type === 'EXIT') {
        return await this.exitPosition(signal.trade, signal.exitPrice, signal.reason);
      }
      
    } catch (error) {
      logger.error(`Strategy ${this.name} execution error:`, error);
      this.metrics.failedEntries++;
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Вхід в позицію
   */
  async enterPosition(marketData) {
    const params = await this.calculatePositionParameters(marketData);
    
    const trade = {
      id: `${marketData.symbol}_${marketData.timestamp}`,
      symbol: marketData.symbol,
      entryTime: marketData.timestamp,
      entryPrice: params.entryPrice,
      quantity: params.quantity,
      tpPrice: params.tpPrice,
      slPrice: params.slPrice,
      status: 'active'
    };
    
    this.activeTrades.set(trade.id, trade);
    
    logger.info(`${this.name}: Entered position ${trade.symbol} at ${trade.entryPrice}`);
    
    return {
      success: true,
      trade
    };
  }
  
  /**
   * Вихід з позиції
   */
  async exitPosition(trade, exitPrice, reason) {
    if (!this.activeTrades.has(trade.id)) {
      return { success: false, error: 'Trade not found' };
    }
    
    trade.exitTime = Date.now();
    trade.exitPrice = exitPrice;
    trade.exitReason = reason;
    trade.status = 'closed';
    
    // Розрахунок комісій та прибутку
    const entryCommission = calculateCommission(
      trade.entryPrice * trade.quantity,
      this.config.binanceFeePercent
    );
    const exitCommission = calculateCommission(
      exitPrice * trade.quantity,
      this.config.binanceFeePercent
    );

    const profitLoss = calculateProfitLoss({
      entryPrice: trade.entryPrice,
      exitPrice,
      quantity: trade.quantity,
      entryCommission,
      exitCommission
    });

    trade.profitLossUsdt = profitLoss.usdt;
    trade.profitLossPercent = profitLoss.percent;
    trade.entryCommission = entryCommission;
    trade.exitCommission = exitCommission;
    
    this.activeTrades.delete(trade.id);
    
    logger.info(`${this.name}: Exited position ${trade.symbol} at ${exitPrice} (${reason}), PnL: ${trade.profitLossPercent.toFixed(2)}%`);
    
    return {
      success: true,
      trade
    };
  }
  
  /**
   * Отримання метрик стратегії
   */
  getMetrics() {
    return {
      name: this.name,
      ...this.metrics,
      activeTradesCount: this.activeTrades.size,
      successRate: this.metrics.totalSignals > 0 
        ? (this.metrics.successfulEntries / this.metrics.totalSignals * 100).toFixed(2) + '%'
        : '0%'
    };
  }
  
  /**
   * Очищення стану стратегії
   */
  reset() {
    this.activeTrades.clear();
    this.metrics = {
      totalSignals: 0,
      successfulEntries: 0,
      failedEntries: 0
    };
  }
  
  /**
   * Оновлення конфігурації
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    logger.info(`${this.name}: Configuration updated`);
  }
}