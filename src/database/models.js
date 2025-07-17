import { getDatabase } from './init.js';
import logger from '../utils/logger.js';

export class SymbolModel {
  constructor() {
    this.dbPromise = getDatabase();
  }

  async create(symbolData) {
    const db = await this.dbPromise;
    const result = await db.run(
      `INSERT INTO symbols (symbol, base_asset, quote_asset, status) VALUES (?, ?, ?, ?)`,
      symbolData.symbol,
      symbolData.baseAsset,
      symbolData.quoteAsset,
      symbolData.status || 'active'
    );
    return result.lastID;
  }

  async findById(id) {
    const db = await this.dbPromise;
    return db.get('SELECT * FROM symbols WHERE id = ?', id);
  }

  async findBySymbol(symbol) {
    const db = await this.dbPromise;
    return db.get('SELECT * FROM symbols WHERE symbol = ?', symbol);
  }

  async getAll() {
    const db = await this.dbPromise;
    return db.all('SELECT * FROM symbols');
  }

  async getActiveUSDTPairs() {
    const db = await this.dbPromise;
    return db.all(
      `SELECT * FROM symbols WHERE status = 'active' AND quote_asset = 'USDT'`
    );
  }

  async update(id, updates) {
    const db = await this.dbPromise;
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    if (fields.length === 0) return false;
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const result = await db.run(
      `UPDATE symbols SET ${setClause}, updated_at = ? WHERE id = ?`,
      ...values,
      Date.now(),
      id
    );
    return result.changes > 0;
  }
}

export class ListingAnalysisModel {
  constructor() {
    this.dbPromise = getDatabase();
  }

  async create(analysisData) {
    const db = await this.dbPromise;
    const result = await db.run(
      `INSERT INTO listing_analysis (symbol_id, listing_date, data_status, error_message, retry_count)
       VALUES (?, ?, ?, ?, ?)`,
      analysisData.symbolId,
      analysisData.listingDate,
      analysisData.dataStatus || 'pending',
      analysisData.errorMessage,
      analysisData.retryCount || 0
    );
    return result.lastID;
  }

  async findBySymbolId(symbolId) {
    const db = await this.dbPromise;
    return db.get('SELECT * FROM listing_analysis WHERE symbol_id = ?', symbolId);
  }

  async getNewListings(daysBack) {
    const db = await this.dbPromise;
    const cutoffDate = Date.now() - daysBack * 24 * 60 * 60 * 1000;
    return db.all(
      `SELECT la.*, s.symbol, s.base_asset, s.quote_asset
       FROM listing_analysis la
       JOIN symbols s ON la.symbol_id = s.id
       WHERE la.data_status = 'analyzed' AND la.listing_date >= ?
       ORDER BY la.listing_date DESC`,
      cutoffDate
    );
  }

  async updateStatus(id, status, errorMessage = null) {
    const db = await this.dbPromise;
    const result = await db.run(
      `UPDATE listing_analysis SET data_status = ?, error_message = ?, analysis_date = ? WHERE id = ?`,
      status,
      errorMessage,
      Date.now(),
      id
    );
    return result.changes > 0;
  }

  async incrementRetryCount(id) {
    const db = await this.dbPromise;
    const result = await db.run(
      `UPDATE listing_analysis SET retry_count = retry_count + 1 WHERE id = ?`,
      id
    );
    return result.changes > 0;
  }
}

export class HistoricalKlineModel {
  constructor() {
    this.dbPromise = getDatabase();
  }

  async createBatch(klines) {
    const db = await this.dbPromise;
    await db.exec('BEGIN');
    try {
      for (const kline of klines) {
        await db.run(
          `INSERT OR IGNORE INTO historical_klines (
            symbol_id, open_time, close_time, open_price, high_price, low_price,
            close_price, volume, quote_asset_volume, number_of_trades,
            taker_buy_base_asset_volume, taker_buy_quote_asset_volume
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ...kline
        );
      }
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  }

  async getBySymbolAndTimeRange(symbolId, startTime, endTime) {
    const db = await this.dbPromise;
    return db.all(
      `SELECT * FROM historical_klines WHERE symbol_id = ? AND open_time >= ? AND open_time <= ? ORDER BY open_time`,
      symbolId,
      startTime,
      endTime
    );
  }

  async getFirstKline(symbolId) {
    const db = await this.dbPromise;
    return db.get(
      `SELECT * FROM historical_klines WHERE symbol_id = ? ORDER BY open_time LIMIT 1`,
      symbolId
    );
  }

  async getKlineCount(symbolId) {
    const db = await this.dbPromise;
    const row = await db.get(
      `SELECT COUNT(*) as count FROM historical_klines WHERE symbol_id = ?`,
      symbolId
    );
    return row.count;
  }

  async deleteBySymbol(symbolId) {
    const db = await this.dbPromise;
    const result = await db.run(
      `DELETE FROM historical_klines WHERE symbol_id = ?`,
      symbolId
    );
    return result.changes;
  }
}

export class SimulationConfigModel {
  constructor() {
    this.dbPromise = getDatabase();
  }

  async create(config) {
    const db = await this.dbPromise;
    const result = await db.run(
      `INSERT INTO simulation_configs (
        name, take_profit_percent, stop_loss_percent,
        trailing_stop_enabled, trailing_stop_percent, trailing_stop_activation_percent,
        buy_amount_usdt, max_open_trades, min_liquidity_usdt,
        binance_fee_percent, cooldown_seconds
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    return result.lastID;
  }

  async findById(id) {
    const db = await this.dbPromise;
    return db.get('SELECT * FROM simulation_configs WHERE id = ?', id);
  }

  async getAll() {
    const db = await this.dbPromise;
    return db.all('SELECT * FROM simulation_configs ORDER BY id');
  }

  async getOptimized(limit = 10) {
    const db = await this.dbPromise;
    return db.all(
      `SELECT sc.*, ss.roi_percent, ss.win_rate_percent, ss.sharpe_ratio
       FROM simulation_configs sc
       LEFT JOIN simulation_summary ss ON sc.id = ss.config_id
       ORDER BY ss.roi_percent DESC NULLS LAST
       LIMIT ?`,
      limit
    );
  }
}

export class SimulationResultModel {
  constructor() {
    this.dbPromise = getDatabase();
  }

  async create(result) {
    const db = await this.dbPromise;
    const res = await db.run(
      `INSERT INTO simulation_results (
        config_id, symbol_id, entry_time, entry_price, exit_time, exit_price,
        exit_reason, quantity, profit_loss_usdt, profit_loss_percent,
        buy_commission, sell_commission, max_price_reached, min_price_reached,
        trailing_stop_triggered
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    return res.lastID;
  }

  async getByConfigId(configId) {
    const db = await this.dbPromise;
    return db.all(
      `SELECT * FROM simulation_results WHERE config_id = ? ORDER BY entry_time`,
      configId
    );
  }

  async getStatsByConfigId(configId) {
    const db = await this.dbPromise;
    return db.get(
      `SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN profit_loss_usdt > 0 THEN 1 ELSE 0 END) as profitable_trades,
        SUM(CASE WHEN profit_loss_usdt < 0 THEN 1 ELSE 0 END) as losing_trades,
        AVG(profit_loss_percent) as avg_profit_percent,
        MAX(profit_loss_percent) as max_profit_percent,
        MIN(profit_loss_percent) as min_profit_percent,
        SUM(profit_loss_usdt) as total_profit_loss
       FROM simulation_results
       WHERE config_id = ?`,
      configId
    );
  }

  async getByTimeWindow(startTime, endTime) {
    const db = await this.dbPromise;
    return db.all(
      `SELECT * FROM simulation_results WHERE entry_time >= ? AND entry_time <= ? ORDER BY entry_time`,
      startTime,
      endTime
    );
  }
}

export class SimulationSummaryModel {
  constructor() {
    this.dbPromise = getDatabase();
  }

  async create(summary) {
    const db = await this.dbPromise;
    const res = await db.run(
      `INSERT INTO simulation_summary (
        config_id, total_trades, profitable_trades, losing_trades, timeout_trades,
        trailing_stop_trades, total_profit_usdt, total_loss_usdt, net_profit_usdt,
        win_rate_percent, avg_profit_percent, avg_loss_percent, max_profit_percent,
        max_loss_percent, avg_trade_duration_minutes, total_simulation_period_days,
        roi_percent, sharpe_ratio, max_drawdown_percent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
    return res.lastID;
  }

  async getTopByROI(limit = 10) {
    const db = await this.dbPromise;
    return db.all(
      `SELECT ss.*, sc.name as config_name, sc.take_profit_percent, sc.stop_loss_percent, sc.trailing_stop_enabled
       FROM simulation_summary ss
       JOIN simulation_configs sc ON ss.config_id = sc.id
       ORDER BY ss.roi_percent DESC
       LIMIT ?`,
      limit
    );
  }

  async getAll() {
    const db = await this.dbPromise;
    return db.all('SELECT * FROM simulation_summary ORDER BY roi_percent DESC');
  }

  async deleteByConfigId(configId) {
    const db = await this.dbPromise;
    const result = await db.run(
      'DELETE FROM simulation_summary WHERE config_id = ?',
      configId
    );
    return result.changes;
  }
}

export const symbolModel = new SymbolModel();
export const listingAnalysisModel = new ListingAnalysisModel();
export const historicalKlineModel = new HistoricalKlineModel();
export const simulationConfigModel = new SimulationConfigModel();
export const simulationResultModel = new SimulationResultModel();
export const simulationSummaryModel = new SimulationSummaryModel();

