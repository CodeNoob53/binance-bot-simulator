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
    // ВИПРАВЛЕНО: Знаходимо оптимальну конфігурацію з перевіркою
    const optimalConfig = await this.findOptimalConfiguration();
    
    // Якщо немає оптимальної конфігурації, використовуємо найкращу з аналізу
    const bestConfig = optimalConfig || (analysisData.configAnalysis.topByROI && analysisData.configAnalysis.topByROI[0]) || {
      name: 'No optimal config found',
      take_profit_percent: 0.02,
      stop_loss_percent: 0.01,
      trailing_stop_enabled: 0,
      trailing_stop_percent: null,
      trailing_stop_activation_percent: null,
      buy_amount_usdt: 100,
      roi_percent: 0,
      win_rate_percent: 0,
      total_trades: 0
    };
    
    // Аналіз найкращих часових вікон
    const bestTimeWindows = analysisData.timePatterns
      .filter(p => p.total_trades > 10)
      .sort((a, b) => b.win_rate - a.win_rate)
      .slice(0, 3);
    
    // Генерація рекомендацій
    const recommendations = {
      bestConfig: {
        name: bestConfig.name || 'Unknown Configuration',
        takeProfitPercent: bestConfig.take_profit_percent || 0.02,
        stopLossPercent: bestConfig.stop_loss_percent || 0.01,
        trailingStopEnabled: Boolean(bestConfig.trailing_stop_enabled),
        trailingStopPercent: bestConfig.trailing_stop_percent || null,
        trailingStopActivationPercent: bestConfig.trailing_stop_activation_percent || null,
        buyAmountUsdt: bestConfig.buy_amount_usdt || 100,
        expectedROI: bestConfig.roi_percent || 0,
        expectedWinRate: bestConfig.win_rate_percent || 0,
        confidence: this.calculateConfidence(bestConfig)
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
    try {
      const db = await this.dbPromise;
      const result = await db.get(`
        SELECT
          sc.*,
          ss.roi_percent,
          ss.win_rate_percent,
          ss.sharpe_ratio,
          ss.max_drawdown_percent,
          ss.total_trades
        FROM simulation_configs sc
        JOIN simulation_summary ss ON sc.id = ss.config_id
        WHERE ss.total_trades >= 10
        ORDER BY 
          (ss.roi_percent * 0.4 + 
           ss.win_rate_percent * 0.3 + 
           (100 - COALESCE(ss.max_drawdown_percent, 100)) * 0.2 +
           COALESCE(ss.sharpe_ratio * 10, 0) * 0.1) DESC
        LIMIT 1
      `);
      
      return result;
    } catch (error) {
      console.error('Error finding optimal configuration:', error.message);
      return null;
    }
  }
  
  calculateConfidence(config) {
    if (!config) return 0;
    
    let confidence = 0;
    
    // Базова оцінка на основі кількості угод
    const totalTrades = config.total_trades || 0;
    if (totalTrades >= 100) confidence += 30;
    else if (totalTrades >= 50) confidence += 20;
    else if (totalTrades >= 20) confidence += 10;
    
    // ROI
    const roi = config.roi_percent || 0;
    if (roi > 50) confidence += 20;
    else if (roi > 20) confidence += 15;
    else if (roi > 10) confidence += 10;
    
    // Win rate
    const winRate = config.win_rate_percent || 0;
    if (winRate > 60) confidence += 20;
    else if (winRate > 50) confidence += 15;
    else if (winRate > 40) confidence += 10;
    
    // Sharpe ratio
    const sharpe = config.sharpe_ratio || 0;
    if (sharpe > 2) confidence += 15;
    else if (sharpe > 1) confidence += 10;
    else if (sharpe > 0.5) confidence += 5;
    
    // Max drawdown
    const drawdown = config.max_drawdown_percent || 0;
    if (drawdown < 10) confidence += 15;
    else if (drawdown < 20) confidence += 10;
    else if (drawdown < 30) confidence += 5;
    
    return Math.min(confidence, 100);
  }
  
  getTimeWindowRecommendation(window) {
    if (!window) return 'Недостатньо даних';
    
    const winRate = window.win_rate || 0;
    if (winRate > 60) return 'Відмінний час для торгівлі';
    if (winRate > 50) return 'Хороший час для торгівлі';
    if (winRate > 40) return 'Прийнятний час для торгівлі';
    return 'Розгляньте інші часові вікна';
  }
  
  generateWarnings(analysisData) {
    const warnings = [];
    
    try {
      // Перевірка загальної прибутковості
      const configAnalysis = analysisData.configAnalysis || {};
      const profitableRate = configAnalysis.totalConfigs > 0 
        ? (configAnalysis.profitableConfigs / configAnalysis.totalConfigs) * 100 
        : 0;
      
      if (profitableRate < 10) {
        warnings.push('Менше 10% конфігурацій показують прибуток - розгляньте зміну параметрів');
      }
      
      // Перевірка середнього ROI
      const avgROI = configAnalysis.statistics?.avgROI || 0;
      if (avgROI < 0) {
        warnings.push('Середній ROI негативний - стратегія потребує оптимізації');
      }
      
      // Перевірка win rate
      const avgWinRate = configAnalysis.statistics?.avgWinRate || 0;
      if (avgWinRate < 30) {
        warnings.push('Низький win rate - розгляньте зменшення take profit або збільшення stop loss');
      }
      
    } catch (error) {
      warnings.push('Помилка при аналізі даних - перевірте якість результатів симуляції');
    }
    
    return warnings;
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
