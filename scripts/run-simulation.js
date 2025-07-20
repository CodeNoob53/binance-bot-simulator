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
    
    // ВИПРАВЛЕННЯ: Перевірка наявності даних з правильними назвами таблиць
    console.log(chalk.yellow('🔍 Checking data availability...'));
    const dataCheck = await checkDataAvailability(db);
    
    if (!dataCheck.hasMinimumData) {
      console.log(chalk.red('\n❌ Insufficient data for simulation!'));
      console.log(chalk.yellow('📊 Current data status:'));
      console.log(`   • Symbols: ${dataCheck.symbolCount}`);
      console.log(`   • Historical K-lines: ${dataCheck.klineCount}`);
      console.log(`   • Symbols with sufficient data: ${dataCheck.validSymbolCount}`);
      console.log(`   • Date range: ${dataCheck.dateRange}`);
      console.log(chalk.white('\n💡 Recommendations:'));
      console.log(chalk.white('   1. Run data collection: npm run collect'));
      console.log(chalk.white('   2. Check if listing analysis completed'));
      console.log(chalk.white('   3. Verify data quality with: npm run diagnose\n'));
      process.exit(1);
    }
    
    console.log(chalk.green(`✅ Data validation passed`));
    console.log(`   • Symbols with data: ${dataCheck.validSymbolCount}`);
    console.log(`   • Total K-lines: ${dataCheck.klineCount}`);
    console.log(`   • Date range: ${dataCheck.dateRange}\n`);
    
    // Генерація конфігурацій
    console.log(chalk.yellow('⚙️  Generating simulation configurations...'));
    const configGenerator = new ConfigurationGenerator();
    await configGenerator.generateConfigurations();
    const configs = await configGenerator.getConfigurations();
    console.log(chalk.green(`✅ Generated ${configs.length} configurations\n`));
    
    // ВИПРАВЛЕННЯ: Додано перевірку валідних конфігурацій
    const validConfigs = configs.filter(config => 
      config.takeProfitPercent > config.stopLossPercent &&
      config.takeProfitPercent > 0 &&
      config.stopLossPercent > 0
    );
    
    if (validConfigs.length === 0) {
      console.log(chalk.red('❌ No valid configurations found!'));
      process.exit(1);
    }
    
    if (validConfigs.length < configs.length) {
      console.log(chalk.yellow(`⚠️  Filtered out ${configs.length - validConfigs.length} invalid configurations`));
    }
    
    // Запуск симуляцій
    console.log(chalk.yellow(`🎲 Running simulations for ${validConfigs.length} configurations...`));
    const results = await runSimulations(validConfigs);
    
    // Збереження результатів
    console.log(chalk.yellow('\n💾 Results saved by simulator'));
    
    // ВИПРАВЛЕННЯ: Покращено виведення результатів з перевіркою наявності даних
    console.log(chalk.cyan('\n📊 Simulation Results Summary:\n'));
    displaySimulationSummary(results);
    
    // Виведення топ результатів тільки якщо є успішні симуляції
    const successfulResults = results.filter(r => 
      !r.summary.error && 
      r.summary.totalTrades > 0 &&
      typeof r.summary.roiPercent === 'number'
    );
    
    if (successfulResults.length > 0) {
      console.log(chalk.cyan('\n📊 Top 10 Configurations by ROI:\n'));
      displayTopResults(successfulResults, 10);
    } else {
      console.log(chalk.yellow('\n⚠️  No successful trades in any configuration'));
      console.log(chalk.yellow('This may indicate:'));
      console.log(chalk.white('   • Market data quality issues'));
      console.log(chalk.white('   • Too strict trading parameters'));
      console.log(chalk.white('   • Insufficient historical data'));
      console.log(chalk.white('   • Need to adjust simulation period\n'));
    }
    
    console.log(chalk.green('\n✨ Simulation completed successfully!\n'));
    
  } catch (error) {
    console.error(chalk.red('\n❌ Error during simulation:'), error);
    process.exit(1);
  }
}

/**
 * ДОДАНО: Перевірка наявності та якості даних
 */
async function checkDataAvailability(db) {
  try {
    const symbolCount = (await db.get('SELECT COUNT(*) as count FROM symbols')).count;
    const klineCount = (await db.get('SELECT COUNT(*) as count FROM historical_klines')).count;
    
    // Перевірка символів з достатньою кількістю даних
    const validSymbolsResult = await db.get(`
      SELECT COUNT(DISTINCT s.id) as count
      FROM symbols s
      JOIN historical_klines hk ON s.id = hk.symbol_id
      JOIN listing_analysis la ON s.id = la.symbol_id
      WHERE la.data_status = 'analyzed'
      GROUP BY s.id
      HAVING COUNT(hk.id) >= 20
    `);
    
    const validSymbolCount = validSymbolsResult?.count || 0;
    
    // Перевірка діапазону дат
    const dateRangeResult = await db.get(`
      SELECT 
        MIN(datetime(open_time/1000, 'unixepoch')) as earliest,
        MAX(datetime(close_time/1000, 'unixepoch')) as latest
      FROM historical_klines
    `);
    
    const dateRange = dateRangeResult?.earliest && dateRangeResult?.latest 
      ? `${dateRangeResult.earliest} - ${dateRangeResult.latest}`
      : 'No data';
    
    return {
      hasMinimumData: symbolCount > 0 && klineCount > 0 && validSymbolCount > 0,
      symbolCount,
      klineCount,
      validSymbolCount,
      dateRange
    };
    
  } catch (error) {
    console.error('Error checking data availability:', error);
    return {
      hasMinimumData: false,
      symbolCount: 0,
      klineCount: 0,
      validSymbolCount: 0,
      dateRange: 'Error'
    };
  }
}

/**
 * ВИПРАВЛЕННЯ: Покращено обробку симуляцій з кращою обробкою помилок
 */
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
        summary: { 
          error: error.message,
          totalTrades: 0,
          roiPercent: 0,
          configName: config.name
        }
      });
    }
  }
  
  progressBar.stop();
  
  return results;
}

/**
 * ДОДАНО: Загальна статистика симуляцій
 */
function displaySimulationSummary(results) {
  const totalConfigs = results.length;
  const successfulConfigs = results.filter(r => !r.summary.error && r.summary.totalTrades > 0).length;
  const errorConfigs = results.filter(r => r.summary.error).length;
  const noTradeConfigs = results.filter(r => !r.summary.error && r.summary.totalTrades === 0).length;
  
  console.log(`📊 Total configurations tested: ${totalConfigs}`);
  console.log(`✅ Successful (with trades): ${successfulConfigs}`);
  console.log(`❌ Errors: ${errorConfigs}`);
  console.log(`⚪ No trades executed: ${noTradeConfigs}`);
  
  if (successfulConfigs > 0) {
    const avgROI = results
      .filter(r => !r.summary.error && r.summary.totalTrades > 0)
      .reduce((sum, r) => sum + r.summary.roiPercent, 0) / successfulConfigs;
    console.log(`📈 Average ROI: ${avgROI.toFixed(2)}%`);
  }
}

/**
 * ВИПРАВЛЕННЯ: Покращено відображення результатів з валідацією
 */
function displayTopResults(results, limit = 10) {
  const sorted = results
    .filter(r => 
      !r.summary.error && 
      r.summary.totalTrades > 0 &&
      typeof r.summary.roiPercent === 'number' &&
      !isNaN(r.summary.roiPercent)
    )
    .sort((a, b) => b.summary.roiPercent - a.summary.roiPercent)
    .slice(0, limit);

  if (sorted.length === 0) {
    console.log('📭 No valid results to display');
    return;
  }

  console.table(sorted.map(({ config, summary }) => ({
    'Config': config.name || 'Unknown',
    'ROI %': (summary.roiPercent || 0).toFixed(2),
    'Win Rate %': (summary.winRate || 0).toFixed(2),
    'Total Trades': summary.totalTrades || 0,
    'Net Profit': `$${(summary.totalReturn || 0).toFixed(2)}`,
    'Sharpe Ratio': (summary.sharpeRatio || 0).toFixed(2),
    'Max Drawdown %': (summary.maxDrawdown || 0).toFixed(2)
  })));
}

// Запуск
main().catch(console.error);