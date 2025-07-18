// src/simulation/configGenerator.js
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
    
    // Зберігаємо в БД (з виправленням)
    await this.saveConfigurations(configs);
    
    return configs;
  }
  
  // ВИПРАВЛЕНО: метод збереження конфігурацій
  async saveConfigurations(configs) {
    const db = await this.dbPromise;
    
    // Спочатку отримуємо всі існуючі конфігурації
    const existingConfigs = await db.all(
      `SELECT name FROM simulation_configs`
    );
    const existingNames = new Set(existingConfigs.map(c => c.name));
    
    // Фільтруємо тільки нові конфігурації
    const newConfigs = configs.filter(config => !existingNames.has(config.name));
    
    if (newConfigs.length === 0) {
      logger.info('All configurations already exist in database');
      return;
    }
    
    logger.info(`Saving ${newConfigs.length} new configurations to database`);
    
    await db.exec('BEGIN');
    try {
      for (const config of newConfigs) {
        await db.run(
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
      }
      await db.exec('COMMIT');
      logger.info(`Successfully saved ${newConfigs.length} configurations`);
    } catch (err) {
      await db.exec('ROLLBACK');
      logger.error(`Failed to save configurations: ${err.message}`);
      throw err;
    }
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

  // ДОДАНО: метод очищення дублікатів 
  async cleanDuplicateConfigs() {
    const db = await this.dbPromise;
    
    logger.info('Cleaning duplicate configurations...');
    
    // Знаходимо дублікати
    const duplicates = await db.all(`
      SELECT name, COUNT(*) as count
      FROM simulation_configs
      GROUP BY name
      HAVING count > 1
    `);
    
    if (duplicates.length === 0) {
      logger.info('No duplicate configurations found');
      return 0;
    }
    
    logger.info(`Found ${duplicates.length} duplicate configuration names`);
    
    let cleaned = 0;
    await db.exec('BEGIN');
    try {
      for (const duplicate of duplicates) {
        // Залишаємо тільки першу конфігурацію з кожним ім'ям
        const keep = await db.get(
          `SELECT id FROM simulation_configs
           WHERE name = ?
           ORDER BY id ASC
           LIMIT 1`,
          duplicate.name
        );
        
        const deleted = await db.run(
          `DELETE FROM simulation_configs
           WHERE name = ? AND id != ?`,
          duplicate.name,
          keep.id
        );
        
        cleaned += deleted.changes;
      }
      await db.exec('COMMIT');
      logger.info(`Cleaned ${cleaned} duplicate configurations`);
    } catch (err) {
      await db.exec('ROLLBACK');
      logger.error(`Failed to clean duplicates: ${err.message}`);
      throw err;
    }
    
    return cleaned;
  }

  // ДОДАНО: метод для скидання всіх конфігурацій
  async resetConfigurations() {
    const db = await this.dbPromise;
    
    logger.info('Resetting all configurations...');
    
    await db.exec('BEGIN');
    try {
      // Видаляємо всі результати симуляцій
      await db.run('DELETE FROM simulation_summary');
      await db.run('DELETE FROM simulation_results');
      
      // Видаляємо всі конфігурації
      await db.run('DELETE FROM simulation_configs');
      
      // Скидаємо AUTO_INCREMENT
      await db.run('DELETE FROM sqlite_sequence WHERE name = "simulation_configs"');
      await db.run('DELETE FROM sqlite_sequence WHERE name = "simulation_results"');
      await db.run('DELETE FROM sqlite_sequence WHERE name = "simulation_summary"');
      
      await db.exec('COMMIT');
      logger.info('Successfully reset all configurations and results');
    } catch (err) {
      await db.exec('ROLLBACK');
      logger.error(`Failed to reset configurations: ${err.message}`);
      throw err;
    }
  }
}