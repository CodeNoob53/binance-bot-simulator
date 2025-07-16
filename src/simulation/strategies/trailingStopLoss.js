import logger from '../../utils/logger.js';

export class TrailingStopLoss {
  constructor(config) {
    this.enabled = config.trailingStopEnabled || false;
    this.trailingPercent = config.trailingStopPercent || 0.05; // 5% за замовчуванням
    this.activationPercent = config.trailingStopActivationPercent || 0.10; // Активується після 10% прибутку
    this.trades = new Map(); // Зберігаємо стан для кожної угоди
  }
  
  initializeTrade(tradeId, entryPrice) {
    if (!this.enabled) return;
    
    this.trades.set(tradeId, {
      entryPrice,
      highestPrice: entryPrice,
      currentStopPrice: null,
      isActivated: false,
      activationPrice: entryPrice * (1 + this.activationPercent)
    });
    
    logger.debug(`Trailing stop initialized for trade ${tradeId} at ${entryPrice}`);
  }
  
  updatePrice(tradeId, currentPrice) {
    if (!this.enabled || !this.trades.has(tradeId)) return null;
    
    const tradeData = this.trades.get(tradeId);
    
    // Оновлюємо найвищу ціну
    if (currentPrice > tradeData.highestPrice) {
      tradeData.highestPrice = currentPrice;
      
      // Перевіряємо активацію
      if (!tradeData.isActivated && currentPrice >= tradeData.activationPrice) {
        tradeData.isActivated = true;
        tradeData.currentStopPrice = currentPrice * (1 - this.trailingPercent);
        logger.info(`Trailing stop activated for trade ${tradeId} at price ${currentPrice}`);
      }
      
      // Оновлюємо stop price якщо активовано
      if (tradeData.isActivated) {
        const newStopPrice = currentPrice * (1 - this.trailingPercent);
        if (newStopPrice > tradeData.currentStopPrice) {
          tradeData.currentStopPrice = newStopPrice;
          logger.debug(`Trailing stop updated for trade ${tradeId}: ${tradeData.currentStopPrice.toFixed(4)}`);
        }
      }
    }
    
    // Перевіряємо спрацювання
    if (tradeData.isActivated && currentPrice <= tradeData.currentStopPrice) {
      this.trades.delete(tradeId);
      logger.info(`Trailing stop triggered for trade ${tradeId} at ${currentPrice}`);
      return {
        triggered: true,
        exitPrice: tradeData.currentStopPrice,
        reason: 'trailing_stop'
      };
    }
    
    return null;
  }
  
  removeTrade(tradeId) {
    this.trades.delete(tradeId);
  }
  
  getTradeStatus(tradeId) {
    if (!this.trades.has(tradeId)) return null;
    
    const tradeData = this.trades.get(tradeId);
    return {
      isActivated: tradeData.isActivated,
      highestPrice: tradeData.highestPrice,
      currentStopPrice: tradeData.currentStopPrice,
      profitFromHighest: tradeData.currentStopPrice ? 
        ((tradeData.highestPrice - tradeData.currentStopPrice) / tradeData.highestPrice * 100).toFixed(2) : null
    };
  }
  
  clear() {
    this.trades.clear();
  }
}