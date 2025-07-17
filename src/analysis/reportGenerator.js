import { getDatabase } from '../database/init.js';
import logger from '../utils/logger.js';
import { formatPercent, formatUSDT, formatDuration } from '../utils/helpers.js';

export class ReportGenerator {
  constructor() {
    this.dbPromise = getDatabase();
  }
  
  async generateFullReport(analysisData) {
    const report = {
      metadata: {
        generatedAt: new Date().toISOString(),
        version: '1.0.0',
        dataRange: await this.getDataRange()
      },
      
      summary: {
        totalConfigurations: analysisData.configAnalysis.totalConfigs,
        profitableConfigs: analysisData.configAnalysis.profitableConfigs,
        avgROI: formatPercent(analysisData.configAnalysis.statistics.avgROI),
        avgWinRate: formatPercent(analysisData.configAnalysis.statistics.avgWinRate),
        avgSharpeRatio: analysisData.configAnalysis.statistics.avgSharpeRatio.toFixed(2)
      },
      
      topConfigurations: {
        byROI: this.formatTopConfigs(analysisData.configAnalysis.topByROI),
        byWinRate: this.formatTopConfigs(analysisData.configAnalysis.topByWinRate),
        bySharpeRatio: this.formatTopConfigs(analysisData.configAnalysis.topBySharpe)
      },
      
      timeAnalysis: this.formatTimePatterns(analysisData.timePatterns),
      
      profitDistribution: analysisData.profitDistribution,
      
      trailingStopAnalysis: this.formatTrailingStopAnalysis(analysisData.trailingStopAnalysis),
      
      recommendations: await this.generateRecommendations(analysisData)
    };
    
    logger.info('Generated comprehensive simulation report');
    return report;
  }
  
  async getDataRange() {
    const db = await this.dbPromise;
    const range = await db.get(`
      SELECT
        MIN(la.listing_date) as earliest_listing,
        MAX(la.listing_date) as latest_listing,
        COUNT(DISTINCT s.id) as total_symbols,
        COUNT(DISTINCT sr.symbol_id) as traded_symbols
      FROM listing_analysis la
      JOIN symbols s ON la.symbol_id = s.id
      LEFT JOIN simulation_results sr ON s.id = sr.symbol_id
      WHERE la.data_status = 'analyzed'
    `);
    
    return {
      earliestListing: new Date(range.earliest_listing).toISOString(),
      latestListing: new Date(range.latest_listing).toISOString(),
      totalSymbols: range.total_symbols,
      tradedSymbols: range.traded_symbols,
      daysAnalyzed: Math.floor((range.latest_listing - range.earliest_listing) / (24 * 60 * 60 * 1000))
    };
  }
  
  formatTopConfigs(configs) {
    return configs.slice(0, 5).map(config => ({
      name: config.name,
      parameters: {
        takeProfitPercent: formatPercent(config.take_profit_percent * 100),
        stopLossPercent: formatPercent(config.stop_loss_percent * 100),
        trailingStop: config.trailing_stop_enabled ? {
          enabled: true,
          percent: formatPercent(config.trailing_stop_percent * 100),
          activationPercent: formatPercent(config.trailing_stop_activation_percent * 100)
        } : { enabled: false },
        buyAmountUsdt: formatUSDT(config.buy_amount_usdt)
      },
      performance: {
        roi: formatPercent(config.roi_percent),
        winRate: formatPercent(config.win_rate_percent),
        sharpeRatio: config.sharpe_ratio?.toFixed(2) || 'N/A',
        maxDrawdown: formatPercent(config.max_drawdown_percent),
        totalTrades: config.total_trades
      }
    }));
  }
  
  formatTimePatterns(patterns) {
    return patterns.map(pattern => ({
      window: pattern.timeWindow,
      totalTrades: pattern.total_trades,
      winRate: formatPercent(pattern.win_rate),
      avgProfit: formatPercent(pattern.avg_profit),
      distribution: {
        takeProfit: pattern.take_profit_count,
        stopLoss: pattern.stop_loss_count,
        trailingStop: pattern.trailing_stop_count,
        timeout: pattern.timeout_count
      }
    }));
  }
  
  formatTrailingStopAnalysis(analysis) {
    const comparison = {};
    
    analysis.comparison.forEach(item => {
      const key = item.trailing_stop_enabled ? 'withTrailingStop' : 'withoutTrailingStop';
      comparison[key] = {
        configCount: item.config_count,
        avgROI: formatPercent(item.avg_roi),
        avgWinRate: formatPercent(item.avg_win_rate),
        avgMaxDrawdown: formatPercent(item.avg_max_drawdown),
        totalTrailingStops: item.total_trailing_stops
      };
    });
    
    return {
      comparison,
      effectiveness: analysis.trailingStopDetails.map(detail => ({
        settings: {
          trailingPercent: formatPercent(detail.trailing_stop_percent * 100),
          activationPercent: formatPercent(detail.trailing_stop_activation_percent * 100)
        },
        tradeCount: detail.trade_count,
        avgProfit: formatPercent(detail.avg_profit),
        avgMaxGainBeforeExit: formatPercent(detail.avg_max_gain)
      }))
    };
  }
  
  async generateRecommendations(analysisData) {
    // Знаходимо оптимальну конфігурацію
    const optimalConfig = await this.findOptimalConfiguration();
    
    // Аналіз найкращих часових вікон
    const bestTimeWindows = analysisData.timePatterns
      .filter(p => p.total_trades > 50)
      .sort((a, b) => b.win_rate - a.win_rate)
      .slice(0, 3);
    
    // Генерація рекомендацій
    const recommendations = {
      bestConfig: {
        name: optimalConfig.name,
        takeProfitPercent: optimalConfig.take_profit_percent,
        stopLossPercent: optimalConfig.stop_loss_percent,
        trailingStopEnabled: optimalConfig.trailing_stop_enabled,
        trailingStopPercent: optimalConfig.trailing_stop_percent,
        trailingStopActivationPercent: optimalConfig.trailing_stop_activation_percent,
        buyAmountUsdt: optimalConfig.buy_amount_usdt,
        expectedROI: optimalConfig.roi_percent,
        expectedWinRate: optimalConfig.win_rate_percent,
        confidence: this.calculateConfidence(optimalConfig)
      },
      
      tradingTimes: bestTimeWindows.map(w => ({
        window: w.timeWindow,
        winRate: w.win_rate,
        recommendation: this.getTimeWindowRecommendation(w)
      })),
      
      warnings: this.generateWarnings(analysisData),
      
      tips: [
        'Почніть з 50% від рекомендованого розміру позиції для тестування',
        'Моніторьте перші 20-30 угод для підтвердження результатів',
        'Будьте готові коригувати параметри при зміні ринкових умов',
        'Використовуйте trailing stop для захисту прибутку в волатильних умовах',
        'Регулярно оновлюйте історичні дані для актуальності симуляції'
      ]
    };
    
    return recommendations;
  }
  
  async findOptimalConfiguration() {
    const db = await this.dbPromise;
    return db.get(`
      SELECT
        sc.*,
        ss.roi_percent,
        ss.win_rate_percent,
        ss.sharpe_ratio,
        ss.max_drawdown_percent,
        ss.total_trades
      FROM simulation_configs sc
      JOIN simulation_summary ss ON sc.id = ss.config_id
      WHERE ss.total_trades >= 20
      AND ss.roi_percent > 0
      ORDER BY 
        (ss.roi_percent * 0.4 + 
         ss.win_rate_percent * 0.3 + 
         (100 - ss.max_drawdown_percent) * 0.2 +
         COALESCE(ss.sharpe_ratio * 10, 0) * 0.1) DESC
      LIMIT 1
    `);
  }
  
  calculateConfidence(config) {
    let confidence = 0;
    
    // Базова оцінка на основі кількості угод
    if (config.total_trades >= 100) confidence += 30;
    else if (config.total_trades >= 50) confidence += 20;
    else if (config.total_trades >= 20) confidence += 10;
    
    // ROI
    if (config.roi_percent > 50) confidence += 20;
    else if (config.roi_percent > 20) confidence += 15;
    else if (config.roi_percent > 10) confidence += 10;
    
    // Win rate
    if (config.win_rate_percent > 60) confidence += 20;
    else if (config.win_rate_percent > 50) confidence += 15;
    else if (config.win_rate_percent > 40) confidence += 10;
    
    // Sharpe ratio
    if (config.sharpe_ratio > 2) confidence += 15;
    else if (config.sharpe_ratio > 1) confidence += 10;
    else if (config.sharpe_ratio > 0.5) confidence += 5;
    
    // Max drawdown
    if (config.max_drawdown_percent < 10) confidence += 15;
    else if (config.max_drawdown_percent < 20) confidence += 10;
    else if (config.max_drawdown_percent < 30) confidence += 5;
    
    return Math.min(confidence, 100);
  }
  
  getTimeWindowRecommendation(window) {
    if (window.win_rate > 60) return 'Відмінний час для торгівлі';
    if (window.win_rate > 50) return 'Хороший час для торгівлі';
    if (window.win_rate > 40) return 'Прийнятний час для торгівлі';
    return 'Розгляньте інші часові вікна';
  }
  
  generateWarnings(analysisData) {
    const warnings = [];
    
    // Перевірка загальної прибутковості
    const profitableRate = (analysisData.configAnalysis.profitableConfigs / analysisData.configAnalysis.totalConfigs) * 100;
    if (profitableRate < 30) {
      warnings.push('Менше 30% конфігурацій показали прибутковість - ринкові умови можуть бути несприятливими');
    }
    
    // Перевірка волатильності результатів
    if (analysisData.configAnalysis.statistics.avgROI < 0) {
      warnings.push('Середній ROI негативний - розгляньте консервативніші параметри');
    }
    
    // Перевірка trailing stop
    const tsComparison = analysisData.trailingStopAnalysis.comparison;
    if (tsComparison.withTrailingStop && tsComparison.withoutTrailingStop) {
      const tsROI = parseFloat(tsComparison.withTrailingStop.avgROI);
      const noTsROI = parseFloat(tsComparison.withoutTrailingStop.avgROI);
      
      if (tsROI < noTsROI * 0.9) {
        warnings.push('Trailing stop показує гірші результати - можливо, потребує налаштування');
      }
    }
    
    // Загальні попередження
    warnings.push('Минулі результати не гарантують майбутніх прибутків');
    warnings.push('Рекомендується почати з малих сум для валідації стратегії');
    
    return warnings;
  }
}
