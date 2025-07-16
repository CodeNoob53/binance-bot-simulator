import { getDatabase } from './init.js';
import logger from '../utils/logger.js';

export class SymbolModel {
  constructor() {
    this.db = getDatabase();
  }
  
  create(symbolData) {
    const stmt = this.db.prepare(`
      INSERT INTO symbols (symbol, base_asset, quote_asset, status)
      VALUES (?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      symbolData.symbol,
      symbolData.baseAsset,
      symbolData.quoteAsset,
      symbolData.status || 'active'
    );
    
    return result.lastInsertRowid;
  }
  
  findById(id) {
    return this.db.prepare('SELECT * FROM symbols WHERE id = ?').get(id);
  }
  
  findBySymbol(symbol) {
    return this.db.prepare('SELECT * FROM symbols WHERE symbol = ?').get(symbol);
  }
  
  getAll() {
    return this.db.prepare('SELECT * FROM symbols').all();
  }
  
  getActiveUSDTPairs() {
    return this.db.prepare(`
      SELECT * FROM symbols 
      WHERE status = 'active' AND quote_asset = 'USDT'
    `).all();
  }
  
  update(id, updates) {
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    
    if (fields.length === 0) return false;
    
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const stmt = this.db.prepare(`
      UPDATE symbols 
      SET ${setClause}, updated_at = ? 
      WHERE id = ?
    `);
    
    const result = stmt.run(...values, Date.now(), id);
    return result.changes > 0;
  }
}

export class ListingAnalysisModel {
  constructor() {
    this.db = getDatabase();
  }
  
  create(analysisData) {
    const stmt = this.db.prepare(`
      INSERT INTO listing_analysis (
        symbol_id, listing_date, data_status, error_message, retry_count
      ) VALUES (?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      analysisData.symbolId,
      analysisData.listingDate,
      analysisData.dataStatus || 'pending',
      analysisData.errorMessage,
      analysisData.retryCount || 0
    );
    
    return result.lastInsertRowid;
  }
  
  findBySymbolId(symbolId) {
    return this.db.prepare(`
      SELECT * FROM listing_analysis WHERE symbol_id = ?
    `).get(symbolId);
  }
  
  getNewListings(daysBack) {
    const cutoffDate = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    
    return this.db.prepare(`
      SELECT 
        la.*,
        s.symbol,
        s.base_asset,
        s.quote_asset
      FROM listing_analysis la
      JOIN symbols s ON la.symbol_id = s.id
      WHERE la.data_status = 'analyzed'
      AND la.listing_date >= ?
      ORDER BY la.listing_date DESC
    `).all(cutoffDate);
  }
  
  updateStatus(id, status, errorMessage = null) {
    const stmt = this.db.prepare(`
      UPDATE listing_analysis 
      SET data_status = ?, error_message = ?, analysis_date = ?
      WHERE id = ?
    `);
    
    const result = stmt.run(status, errorMessage, Date.now(), id);
    return result.changes > 0;
  }
  
  incrementRetryCount(id) {
    const stmt = this.db.prepare(`
      UPDATE listing_analysis 
      SET retry_count = retry_count + 1 
      WHERE id = ?
    `);
    
    const result = stmt.run(id);
    return result.changes > 0;
  }
}

export class HistoricalKlineModel {
  constructor() {
    this.db = getDatabase();
  }
  
  createBatch(klines) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO historical_klines (
        symbol_id, open_time, close_time, open_price, high_price, low_price,
        close_price, volume, quote_asset_volume, number_of_trades,
        taker_buy_base_asset_volume, taker_buy_quote_asset_volume
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const insertMany = this.db.transaction((klines) => {
      for (const kline of klines) {
        stmt.run(...kline);
      }
    });
    
    insertMany(klines);
  }
  
  getBySymbolAndTimeRange(symbolId, startTime, endTime) {
    return this.db.prepare(`
      SELECT * FROM historical_klines
      WHERE symbol_id = ?
      AND open_time >= ?
      AND open_time <= ?
      ORDER BY open_time
    `).all(symbolId, startTime, endTime);
  }
  
  getFirstKline(symbolId) {
    return this.db.prepare(`
      SELECT * FROM historical_klines
      WHERE symbol_id = ?
      ORDER BY open_time
      LIMIT 1
    `).get(symbolId);
  }
  
  getKlineCount(symbolId) {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM historical_klines
      WHERE symbol_id = ?
    `).get(symbolId);
    
    return result.count;
  }
  
  deleteBySymbol(symbolId) {
    const stmt = this.db.prepare(`
      DELETE FROM historical_klines WHERE symbol_id = ?
    `);
    
    const result = stmt.run(symbolId);
    return result.changes;
  }
}

export class SimulationConfigModel {
  constructor() {
    this.db = getDatabase();
  }
  
  create(config) {
    const stmt = this.db.prepare(`
      INSERT INTO simulation_configs (
        name, take_profit_percent, stop_loss_percent,
        trailing_stop_enabled, trailing_stop_percent, trailing_stop_activation_percent,
        buy_amount_usdt, max_open_trades, min_liquidity_usdt,
        binance_fee_percent, cooldown_seconds
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      config.name,
      config.takeProfitPercent,
      config.stopLossPercent,
      config.trailingStopEnabled,
      config.trailingStopPercent,
      config.trailingStopActivationPercent,
      config.buyAmountUsdt,
      config.maxOpenTrades,
      config.minLiquidityUsdt,
      config.binanceFeePercent,
      config.cooldownSeconds
    );
    
    return result.lastInsertRowid;
  }
  
  findById(id) {
    return this.db.prepare('SELECT * FROM simulation_configs WHERE id = ?').get(id);
  }
  
  getAll() {
    return this.db.prepare('SELECT * FROM simulation_configs ORDER BY id').all();
  }
  
  getOptimized(limit = 10) {
    return this.db.prepare(`
      SELECT 
        sc.*,
        ss.roi_percent,
        ss.win_rate_percent,
        ss.sharpe_ratio
      FROM simulation_configs sc
      LEFT JOIN simulation_summary ss ON sc.id = ss.config_id
      ORDER BY ss.roi_percent DESC NULLS LAST
      LIMIT ?
    `).all(limit);
  }
}

export class SimulationResultModel {
  constructor() {
    this.db = getDatabase();
  }
  
  create(result) {
    const stmt = this.db.prepare(`
      INSERT INTO simulation_results (
        config_id, symbol_id, entry_time, entry_price, exit_time, exit_price,
        exit_reason, quantity, profit_loss_usdt, profit_loss_percent,
        buy_commission, sell_commission, max_price_reached, min_price_reached,
        trailing_stop_triggered
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const insertResult = stmt.run(
      result.configId,
      result.symbolId,
      result.entryTime,
      result.entryPrice,
      result.exitTime,
      result.exitPrice,
      result.exitReason,
      result.quantity,
      result.profitLossUsdt,
      result.profitLossPercent,
      result.buyCommission,
      result.sellCommission,
      result.maxPriceReached,
      result.minPriceReached,
      result.trailingStopTriggered
    );
    
    return insertResult.lastInsertRowid;
  }
  
  getByConfigId(configId) {
    return this.db.prepare(`
      SELECT * FROM simulation_results 
      WHERE config_id = ? 
      ORDER BY entry_time
    `).all(configId);
  }
  
  getStatsByConfigId(configId) {
    return this.db.prepare(`
      SELECT 
        COUNT(*) as total_trades,
        SUM(CASE WHEN profit_loss_usdt > 0 THEN 1 ELSE 0 END) as profitable_trades,
        SUM(CASE WHEN profit_loss_usdt < 0 THEN 1 ELSE 0 END) as losing_trades,
        AVG(profit_loss_percent) as avg_profit_percent,
        MAX(profit_loss_percent) as max_profit_percent,
        MIN(profit_loss_percent) as min_profit_percent,
        SUM(profit_loss_usdt) as total_profit_loss
      FROM simulation_results
      WHERE config_id = ?
    `).get(configId);
  }
  
  getByTimeWindow(startTime, endTime) {
    return this.db.prepare(`
      SELECT * FROM simulation_results
      WHERE entry_time >= ? AND entry_time <= ?
      ORDER BY entry_time
    `).all(startTime, endTime);
  }
}

export class SimulationSummaryModel {
  constructor() {
    this.db = getDatabase();
  }
  
  create(summary) {
    const stmt = this.db.prepare(`
      INSERT INTO simulation_summary (
        config_id, total_trades, profitable_trades, losing_trades, timeout_trades,
        trailing_stop_trades, total_profit_usdt, total_loss_usdt, net_profit_usdt,
        win_rate_percent, avg_profit_percent, avg_loss_percent, max_profit_percent,
        max_loss_percent, avg_trade_duration_minutes, total_simulation_period_days,
        roi_percent, sharpe_ratio, max_drawdown_percent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    return stmt.run(
      summary.configId,
      summary.totalTrades,
      summary.profitableTrades,
      summary.losingTrades,
      summary.timeoutTrades,
      summary.trailingStopTrades,
      summary.totalProfitUsdt,
      summary.totalLossUsdt,
      summary.netProfitUsdt,
      summary.winRatePercent,
      summary.avgProfitPercent,
      summary.avgLossPercent,
      summary.maxProfitPercent,
      summary.maxLossPercent,
      summary.avgTradeDurationMinutes,
      summary.totalSimulationPeriodDays,
      summary.roiPercent,
      summary.sharpeRatio,
      summary.maxDrawdownPercent
    ).lastInsertRowid;
  }
  
  getTopByROI(limit = 10) {
    return this.db.prepare(`
      SELECT 
        ss.*,
        sc.name as config_name,
        sc.take_profit_percent,
        sc.stop_loss_percent,
        sc.trailing_stop_enabled
      FROM simulation_summary ss
      JOIN simulation_configs sc ON ss.config_id = sc.id
      ORDER BY ss.roi_percent DESC
      LIMIT ?
    `).all(limit);
  }
  
  getAll() {
    return this.db.prepare(`
      SELECT * FROM simulation_summary ORDER BY roi_percent DESC
    `).all();
  }
  
  deleteByConfigId(configId) {
    const stmt = this.db.prepare('DELETE FROM simulation_summary WHERE config_id = ?');
    return stmt.run(configId).changes;
  }
}

// Export singleton instances
export const symbolModel = new SymbolModel();
export const listingAnalysisModel = new ListingAnalysisModel();
export const historicalKlineModel = new HistoricalKlineModel();
export const simulationConfigModel = new SimulationConfigModel();
export const simulationResultModel = new SimulationResultModel();
export const simulationSummaryModel = new SimulationSummaryModel();