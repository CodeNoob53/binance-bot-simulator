import { getDatabase } from '../database/init.js';
import logger from '../utils/logger.js';

export class ConfigurationGenerator {
  constructor() {
    this.dbPromise = getDatabase();
  }
  
  async generateConfigurations() {
    logger.info('Generating simulation configurations...');
    
    const configs = [];
    
    // Базові параметри
    const baseParams = {
      maxOpenTrades: 3,
      minLiquidityUsdt: 10000,
      binanceFeePercent: 0.00075,
      cooldownSeconds: 3600
    };
    
    // Варіації параметрів
    const variations = {
      takeProfitPercent: [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40],
      stopLossPercent: [0.05, 0.08, 0.10, 0.12, 0.15],
      buyAmountUsdt: [25, 50, 100, 200],
      trailingStop: [
        { enabled: false },
        { enabled: true, percent: 0.03, activation: 0.05 },
        { enabled: true, percent: 0.05, activation: 0.10 },
        { enabled: true, percent: 0.08, activation: 0.15 },
        { enabled: true, percent: 0.10, activation: 0.20 }
      ]
    };
    
    // Генеруємо всі комбінації
    for (const tp of variations.takeProfitPercent) {
      for (const sl of variations.stopLossPercent) {
        // Stop loss має бути менше take profit
        if (sl >= tp) continue;
        
        for (const amount of variations.buyAmountUsdt) {
          for (const trailing of variations.trailingStop) {
            const config = {
              ...baseParams,
              takeProfitPercent: tp,
              stopLossPercent: sl,
              buyAmountUsdt: amount,
              trailingStopEnabled: trailing.enabled ? 1 : 0,
              trailingStopPercent: trailing.percent || null,
              trailingStopActivationPercent: trailing.activation || null
            };
            
            // Генеруємо ім'я конфігурації
            let name = `TP${(tp * 100).toFixed(0)}_SL${(sl * 100).toFixed(0)}_${amount}USDT`;
            if (trailing.enabled) {
              name += `_TS${(trailing.percent * 100).toFixed(0)}_A${(trailing.activation * 100).toFixed(0)}`;
            }
            
            config.name = name;
            configs.push(config);
          }
        }
      }
    }
    
    logger.info(`Generated ${configs.length} configurations`);
    
    // Зберігаємо в БД
    await this.saveConfigurations(configs);
    
    return configs;
  }
  
  async saveConfigurations(configs) {
    const db = await this.dbPromise;
    await db.exec('BEGIN');
    try {
      for (const config of configs) {
        await db.run(
          `INSERT OR IGNORE INTO simulation_configs (
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
      }
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
    logger.info(`Saved ${configs.length} configurations to database`);
  }

  async getConfigurations() {
    const db = await this.dbPromise;
    return db.all(`
      SELECT
        id,
        name,
        take_profit_percent AS takeProfitPercent,
        stop_loss_percent AS stopLossPercent,
        trailing_stop_enabled AS trailingStopEnabled,
        trailing_stop_percent AS trailingStopPercent,
        trailing_stop_activation_percent AS trailingStopActivationPercent,
        buy_amount_usdt AS buyAmountUsdt,
        max_open_trades AS maxOpenTrades,
        min_liquidity_usdt AS minLiquidityUsdt,
        binance_fee_percent AS binanceFeePercent,
        cooldown_seconds AS cooldownSeconds,
        created_at AS createdAt
      FROM simulation_configs
      ORDER BY id
    `);
  }

  async getOptimizedConfigurations(limit = 10) {
    // Отримуємо топ конфігурації на основі попередніх симуляцій
    const db = await this.dbPromise;
    return db.all(`
      SELECT
        sc.id,
        sc.name,
        sc.take_profit_percent AS takeProfitPercent,
        sc.stop_loss_percent AS stopLossPercent,
        sc.trailing_stop_enabled AS trailingStopEnabled,
        sc.trailing_stop_percent AS trailingStopPercent,
        sc.trailing_stop_activation_percent AS trailingStopActivationPercent,
        sc.buy_amount_usdt AS buyAmountUsdt,
        sc.max_open_trades AS maxOpenTrades,
        sc.min_liquidity_usdt AS minLiquidityUsdt,
        sc.binance_fee_percent AS binanceFeePercent,
        sc.cooldown_seconds AS cooldownSeconds,
        sc.created_at AS createdAt,
        ss.roi_percent AS roiPercent,
        ss.win_rate_percent AS winRatePercent,
        ss.sharpe_ratio AS sharpeRatio
      FROM simulation_configs sc
      LEFT JOIN simulation_summary ss ON sc.id = ss.config_id
      ORDER BY ss.roi_percent DESC NULLS LAST
      LIMIT ?
    `,
    limit);
  }
}
