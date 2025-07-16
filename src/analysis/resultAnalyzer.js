import { getDatabase } from '../database/init.js';
import { average, groupBy } from '../utils/helpers.js';
import logger from '../utils/logger.js';

export class ResultAnalyzer {
  constructor() {
    this.db = getDatabase();
  }
  
  async analyzeConfigurations() {
    const summaries = this.db.prepare(`
      SELECT 
        sc.*,
        ss.*
      FROM simulation_summary ss
      JOIN simulation_configs sc ON ss.config_id = sc.id
      WHERE ss.total_trades > 10
      ORDER BY ss.roi_percent DESC
    `).all();
    
    return {
      totalConfigs: summaries.length,
      profitableConfigs: summaries.filter(s => s.roi_percent > 0).length,
      topByROI: summaries.slice(0, 10),
      topByWinRate: [...summaries].sort((a, b) => b.win_rate_percent - a.win_rate_percent).slice(0, 10),
      topBySharpe: [...summaries].sort((a, b) => b.sharpe_ratio - a.sharpe_ratio).slice(0, 10),
      statistics: {
        avgROI: average(summaries.map(s => s.roi_percent)),
        avgWinRate: average(summaries.map(s => s.win_rate_percent)),
        avgSharpeRatio: average(summaries.map(s => s.sharpe_ratio).filter(s => s !== null))
      }
    };
  }
  
  async analyzeTimePatterns() {
    const timeWindows = [
      { name: '0-5min', start: 0, end: 5 * 60 * 1000 },
      { name: '5-15min', start: 5 * 60 * 1000, end: 15 * 60 * 1000 },
      { name: '15-60min', start: 15 * 60 * 1000, end: 60 * 60 * 1000 },
      { name: '1-6hour', start: 60 * 60 * 1000, end: 6 * 60 * 60 * 1000 },
      { name: '6-24hour', start: 6 * 60 * 60 * 1000, end: 24 * 60 * 60 * 1000 },
      { name: '24-48hour', start: 24 * 60 * 60 * 1000, end: 48 * 60 * 60 * 1000 }
    ];
    
    const results = [];
    
    for (const window of timeWindows) {
      const trades = this.db.prepare(`
        SELECT 
          COUNT(*) as total_trades,
          AVG(CASE WHEN exit_reason IN ('take_profit', 'trailing_stop') THEN 1 ELSE 0 END) * 100 as win_rate,
          AVG(profit_loss_percent) as avg_profit,
          COUNT(CASE WHEN exit_reason = 'take_profit' THEN 1 END) as take_profit_count,
          COUNT(CASE WHEN exit_reason = 'stop_loss' THEN 1 END) as stop_loss_count,
          COUNT(CASE WHEN exit_reason = 'trailing_stop' THEN 1 END) as trailing_stop_count,
          COUNT(CASE WHEN exit_reason = 'timeout' THEN 1 END) as timeout_count
        FROM simulation_results 
        WHERE (exit_time - entry_time) BETWEEN ? AND ?
        AND exit_time IS NOT NULL
      `).get(window.start, window.end);
      
      results.push({
        timeWindow: window.name,
        ...trades
      });
    }
    
    return results;
  }
  
  async analyzeProfitDistribution() {
    const distribution = this.db.prepare(`
      SELECT 
        CASE 
          WHEN profit_loss_percent < -20 THEN '< -20%'
          WHEN profit_loss_percent < -15 THEN '-20% to -15%'
          WHEN profit_loss_percent < -10 THEN '-15% to -10%'
          WHEN profit_loss_percent < -5 THEN '-10% to -5%'
          WHEN profit_loss_percent < 0 THEN '-5% to 0%'
          WHEN profit_loss_percent < 5 THEN '0% to 5%'
          WHEN profit_loss_percent < 10 THEN '5% to 10%'
          WHEN profit_loss_percent < 15 THEN '10% to 15%'
          WHEN profit_loss_percent < 20 THEN '15% to 20%'
          WHEN profit_loss_percent < 30 THEN '20% to 30%'
          ELSE '> 30%'
        END as profit_range,
        COUNT(*) as count,
        AVG(profit_loss_percent) as avg_profit
      FROM simulation_results
      WHERE profit_loss_percent IS NOT NULL
      GROUP BY profit_range
      ORDER BY MIN(profit_loss_percent)
    `).all();
    
    return distribution;
  }
  
  async analyzeTrailingStopEffectiveness() {
    // Порівняння конфігурацій з та без trailing stop
    const comparison = this.db.prepare(`
      SELECT 
        sc.trailing_stop_enabled,
        COUNT(DISTINCT sc.id) as config_count,
        AVG(ss.roi_percent) as avg_roi,
        AVG(ss.win_rate_percent) as avg_win_rate,
        AVG(ss.max_drawdown_percent) as avg_max_drawdown,
        SUM(ss.trailing_stop_trades) as total_trailing_stops
      FROM simulation_configs sc
      JOIN simulation_summary ss ON sc.id = ss.config_id
      GROUP BY sc.trailing_stop_enabled
    `).all();
    
    // Детальний аналіз trailing stop trades
    const trailingStopDetails = this.db.prepare(`
      SELECT 
        sc.trailing_stop_percent,
        sc.trailing_stop_activation_percent,
        COUNT(sr.id) as trade_count,
        AVG(sr.profit_loss_percent) as avg_profit,
        AVG((sr.max_price_reached - sr.entry_price) / sr.entry_price * 100) as avg_max_gain
      FROM simulation_results sr
      JOIN simulation_configs sc ON sr.config_id = sc.id
      WHERE sr.exit_reason = 'trailing_stop'
      GROUP BY sc.trailing_stop_percent, sc.trailing_stop_activation_percent
    `).all();
    
    return {
      comparison,
      trailingStopDetails
    };
  }
  
  async findOptimalParameters() {
    // Комплексний аналіз для пошуку оптимальних параметрів
    const results = this.db.prepare(`
      SELECT 
        sc.*,
        ss.roi_percent,
        ss.win_rate_percent,
        ss.sharpe_ratio,
        ss.max_drawdown_percent,
        ss.total_trades,
        (ss.roi_percent * 0.4 + 
         ss.win_rate_percent * 0.3 + 
         (100 - ss.max_drawdown_percent) * 0.2 +
         COALESCE(ss.sharpe_ratio * 10, 0) * 0.1) as combined_score
      FROM simulation_configs sc
      JOIN simulation_summary ss ON sc.id = ss.config_id
      WHERE ss.total_trades >= 20
      ORDER BY combined_score DESC
      LIMIT 1
    `).get();
    
    return results;
  }
}