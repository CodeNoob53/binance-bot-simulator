import { getDatabase } from '../database/init.js';
import logger from '../utils/logger.js';
import { TrailingStopLoss } from './strategies/trailingStopLoss.js';

export class TradingSimulator {
  constructor(config) {
    this.config = config;
    this.db = getDatabase();
    this.activeTrades = new Map();
    this.completedTrades = [];
    this.currentBalance = parseFloat(process.env.INITIAL_BALANCE_USDT) || 10000;
    this.initialBalance = this.currentBalance;
    this.cooldownMap = new Map();
    this.trailingStopLoss = new TrailingStopLoss(config);
    this.stats = {
      totalTrades: 0,
      profitableTrades: 0,
      losingTrades: 0,
      timeoutTrades: 0,
      trailingStopTrades: 0
    };
  }
  
  async runSimulation(daysBack = 180) {
    logger.info(`Starting simulation: ${this.config.name}`);
    
    const newListings = await this.getNewListingsWithData(daysBack);
    logger.info(`Found ${newListings.length} new listings to simulate`);
    
    // Сортуємо за датою лістингу
    newListings.sort((a, b) => a.listing_date - b.listing_date);
    
    for (const listing of newListings) {
      await this.processListing(listing);
    }
    
    // Закриваємо активні угоди
    await this.closeAllActiveTrades('timeout');
    
    return this.generateResults();
  }
  
  async getNewListingsWithData(daysBack) {
    const cutoffDate = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    
    return this.db.prepare(`
      SELECT 
        s.id as symbol_id,
        s.symbol,
        la.listing_date,
        COUNT(hk.id) as klines_count
      FROM symbols s
      JOIN listing_analysis la ON s.id = la.symbol_id
      LEFT JOIN historical_klines hk ON s.id = hk.symbol_id
      WHERE la.data_status = 'analyzed'
      AND la.listing_date >= ?
      GROUP BY s.id
      HAVING klines_count > 0
      ORDER BY la.listing_date
    `).all(cutoffDate);
  }
  
  async processListing(listing) {
    const { symbol_id, symbol, listing_date } = listing;
    
    // Перевірки
    if (this.isOnCooldown(symbol)) {
      logger.debug(`${symbol} is on cooldown`);
      return;
    }
    
    if (this.activeTrades.size >= this.config.maxOpenTrades) {
      logger.debug(`Max trades limit reached: ${this.activeTrades.size}/${this.config.maxOpenTrades}`);
      return;
    }
    
    const requiredBalance = this.config.buyAmountUsdt * (1 + this.config.binanceFeePercent);
    if (this.currentBalance < requiredBalance) {
      logger.debug(`Insufficient balance: ${this.currentBalance} < ${requiredBalance}`);
      return;
    }
    
    // Перевірка ліквідності (перша хвилина)
    const liquidity = await this.checkLiquidity(symbol_id, listing_date);
    if (liquidity < this.config.minLiquidityUsdt) {
      logger.debug(`${symbol} insufficient liquidity: ${liquidity} < ${this.config.minLiquidityUsdt}`);
      return;
    }
    
    // Симуляція входу
    const trade = await this.simulateEntry(symbol_id, symbol, listing_date);
    if (trade) {
      this.activeTrades.set(trade.id, trade);
      this.setCooldown(symbol);
      
      // Ініціалізація trailing stop
      this.trailingStopLoss.initializeTrade(trade.id, trade.entryPrice);
      
      // Симуляція виходу
      await this.simulateExit(trade);
    }
  }
  
  async checkLiquidity(symbolId, timestamp) {
    const firstMinute = this.db.prepare(`
      SELECT quote_asset_volume
      FROM historical_klines
      WHERE symbol_id = ? AND open_time = ?
      LIMIT 1
    `).get(symbolId, timestamp);
    
    return firstMinute ? parseFloat(firstMinute.quote_asset_volume) : 0;
  }
  
  async simulateEntry(symbolId, symbol, listingTimestamp) {
    const firstKline = this.db.prepare(`
      SELECT * FROM historical_klines
      WHERE symbol_id = ? AND open_time = ?
      LIMIT 1
    `).get(symbolId, listingTimestamp);
    
    if (!firstKline) {
      logger.warn(`No kline data for ${symbol} at ${new Date(listingTimestamp).toISOString()}`);
      return null;
    }
    
    const entryPrice = parseFloat(firstKline.open_price);
    const quantity = this.config.buyAmountUsdt / entryPrice;
    const buyCommission = this.config.buyAmountUsdt * this.config.binanceFeePercent;
    
    // Розрахунок TP/SL
    const feeAdjustment = 2 * this.config.binanceFeePercent;
    const tpPrice = entryPrice * (1 + this.config.takeProfitPercent + feeAdjustment);
    const slPrice = entryPrice * (1 - this.config.stopLossPercent - feeAdjustment);
    
    const trade = {
      id: `${symbolId}_${listingTimestamp}`,
      symbolId,
      symbol,
      entryTime: listingTimestamp,
      entryPrice,
      quantity,
      tpPrice,
      slPrice,
      buyCommission,
      maxPriceReached: entryPrice,
      minPriceReached: entryPrice
    };
    
    // Оновлюємо баланс
    this.currentBalance -= (this.config.buyAmountUsdt + buyCommission);
    this.stats.totalTrades++;
    
    logger.info(`Entered trade: ${symbol} at ${entryPrice.toFixed(4)}, TP: ${tpPrice.toFixed(4)}, SL: ${slPrice.toFixed(4)}`);
    
    return trade;
  }
  
  async simulateExit(trade) {
    const maxExitTime = trade.entryTime + (48 * 60 * 60 * 1000); // 48 годин
    
    const klines = this.db.prepare(`
      SELECT * FROM historical_klines
      WHERE symbol_id = ? 
      AND open_time > ?
      AND open_time <= ?
      ORDER BY open_time
    `).all(trade.symbolId, trade.entryTime, maxExitTime);
    
    for (const kline of klines) {
      const highPrice = parseFloat(kline.high_price);
      const lowPrice = parseFloat(kline.low_price);
      const closePrice = parseFloat(kline.close_price);
      
      // Оновлюємо екстремуми
      trade.maxPriceReached = Math.max(trade.maxPriceReached, highPrice);
      trade.minPriceReached = Math.min(trade.minPriceReached, lowPrice);
      
      // Перевірка trailing stop
      const trailingResult = this.trailingStopLoss.updatePrice(trade.id, closePrice);
      if (trailingResult && trailingResult.triggered) {
        await this.closeTrade(trade, trailingResult.exitPrice, kline.open_time, 'trailing_stop');
        this.stats.trailingStopTrades++;
        return;