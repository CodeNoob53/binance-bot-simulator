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
    await initializeDatabase();
    const db = await getDatabase();
    
    // Перевірка наявності даних
    const symbolCount = (await db.get('SELECT COUNT(*) as count FROM symbols')).count;
    const klineCount = (await db.get('SELECT COUNT(*) as count FROM historical_klines')).count;
    
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
    // Результати вже збережені всередині TradingSimulator
    // тож додаткове збереження не потрібне
    console.log(chalk.yellow('\n💾 Results saved by simulator'));
    
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
        summary: result.summary
      });

    } catch (error) {
      logger.error(`Simulation failed for ${config.name}:`, error);
      results.push({
        config,
        summary: { error: error.message }
      });
    }
  }
  
  progressBar.stop();
  
  return results;
}


function displayTopResults(results, limit = 10) {
  const sorted = results
    .filter(r => !r.summary.error && r.summary.totalTrades > 0)
    .sort((a, b) => b.summary.roiPercent - a.summary.roiPercent)
    .slice(0, limit);

  console.table(sorted.map(({ config, summary }) => ({
    'Config': config.name,
    'ROI %': summary.roiPercent.toFixed(2),
    'Win Rate %': summary.winRate.toFixed(2),
    'Total Trades': summary.totalTrades,
    'Net Profit': `$${summary.totalReturn.toFixed(2)}`,
    'Sharpe Ratio': summary.sharpeRatio.toFixed(2),
    'Max Drawdown %': summary.maxDrawdown.toFixed(2)
  })));
}

// Запуск
main().catch(console.error);
