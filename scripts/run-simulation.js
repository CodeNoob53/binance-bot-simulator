#!/usr/bin/env node

import 'dotenv/config';
import { initializeDatabase } from '../src/database/init.js';
import { ConfigurationGenerator } from '../src/simulation/configGenerator.js';
import { TradingSimulator } from '../src/simulation/simulator.js';
import { getDatabase } from '../src/database/init.js';
import logger from '../src/utils/logger.js';
import chalk from 'chalk';
import cliProgress from 'cli-progress';

async function main() {
  console.log(chalk.cyan('\n🚀 Starting trading simulation...\n'));
  
  try {
    // Ініціалізація БД
    console.log(chalk.yellow('📊 Initializing database...'));
    initializeDatabase();
    const db = getDatabase();
    
    // Перевірка наявності даних
    const symbolCount = db.prepare('SELECT COUNT(*) as count FROM symbols').get().count;
    const klineCount = db.prepare('SELECT COUNT(*) as count FROM historical_klines').get().count;
    
    if (symbolCount === 0 || klineCount === 0) {
      console.log(chalk.red('\n❌ No data found! Please run data collection first:'));
      console.log(chalk.white('   npm run collect\n'));
      process.exit(1);
    }
    
    console.log(chalk.green(`✅ Found ${symbolCount} symbols and ${klineCount} klines\n`));
    
    // Генерація конфігурацій
    console.log(chalk.yellow('⚙️  Generating simulation configurations...'));
    const configGenerator = new ConfigurationGenerator();
    await configGenerator.generateConfigurations();
    const configs = await configGenerator.getConfigurations();
    console.log(chalk.green(`✅ Generated ${configs.length} configurations\n`));
    
    // Запуск симуляцій
    console.log(chalk.yellow('🎲 Running simulations...'));
    const results = await runSimulations(configs);
    
    // Збереження результатів
    console.log(chalk.yellow('\n💾 Saving results...'));
    await saveSimulationSummaries(results);
    
    // Виведення топ результатів
    console.log(chalk.cyan('\n📊 Top 10 Configurations by ROI:\n'));
    displayTopResults(results, 10);
    
    console.log(chalk.green('\n✨ Simulation completed successfully!\n'));
    
  } catch (error) {
    console.error(chalk.red('\n❌ Error during simulation:'), error);
    process.exit(1);
  }
}

async function runSimulations(configs) {
  const results = [];
  
  // Progress bar
  const progressBar = new cliProgress.SingleBar({
    format: 'Simulating |{bar}| {percentage}% | {value}/{total} | Config: {config}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
  });
  
  progressBar.start(configs.length, 0);
  
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    progressBar.update(i + 1, { config: config.name });
    
    try {
      const simulator = new TradingSimulator(config);
      const result = await simulator.runSimulation(180); // 180 днів
      
      results.push({
        config,
        result
      });
      
    } catch (error) {
      logger.error(`Simulation failed for ${config.name}:`, error);
      results.push({
        config,
        result: { error: error.message }
      });
    }
  }
  
  progressBar.stop();
  
  return results;
}

async function saveSimulationSummaries(results) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO simulation_summary (
      config_id, total_trades, profitable_trades, losing_trades, timeout_trades,
      trailing_stop_trades, total_profit_usdt, total_loss_usdt, net_profit_usdt,
      win_rate_percent, avg_profit_percent, avg_loss_percent, max_profit_percent,
      max_loss_percent, avg_trade_duration_minutes, total_simulation_period_days,
      roi_percent, sharpe_ratio, max_drawdown_percent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const insertMany = db.transaction((results) => {
    for (const { config, result } of results) {
      if (result.error) continue;
      
      // Розрахунок додаткових метрик
      const avgProfitPercent = result.profitableTrades > 0 ?
        result.totalProfitUsdt / result.profitableTrades / config.buyAmountUsdt * 100 : 0;
      const avgLossPercent = result.losingTrades > 0 ?
        result.totalLossUsdt / result.losingTrades / config.buyAmountUsdt * 100 : 0;
      
      stmt.run(
        config.id,
        result.totalTrades,
        result.profitableTrades,
        result.losingTrades,
        result.timeoutTrades,
        result.trailingStopTrades || 0,
        result.totalProfitUsdt,
        result.totalLossUsdt,
        result.netProfitUsdt,
        result.winRatePercent,
        avgProfitPercent,
        avgLossPercent,
        0, // max_profit_percent - потребує додаткового розрахунку
        0, // max_loss_percent - потребує додаткового розрахунку
        0, // avg_trade_duration_minutes - потребує додаткового розрахунку
        180, // total_simulation_period_days
        result.roiPercent,
        result.sharpeRatio,
        result.maxDrawdown
      );
    }
  });
  
  insertMany(results);
}

function displayTopResults(results, limit = 10) {
  const sorted = results
    .filter(r => !r.result.error && r.result.totalTrades > 0)
    .sort((a, b) => b.result.roiPercent - a.result.roiPercent)
    .slice(0, limit);
  
  console.table(sorted.map(({ config, result }) => ({
    'Config': config.name,
    'ROI %': result.roiPercent.toFixed(2),
    'Win Rate %': result.winRatePercent.toFixed(2),
    'Total Trades': result.totalTrades,
    'Net Profit': `$${result.netProfitUsdt.toFixed(2)}`,
    'Sharpe Ratio': result.sharpeRatio.toFixed(2),
    'Max Drawdown %': result.maxDrawdown.toFixed(2)
  })));
}

// Запуск
main().catch(console.error);