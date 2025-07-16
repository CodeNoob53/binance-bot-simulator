#!/usr/bin/env node

/**
 * Binance Trading Bot - Main Entry Point
 * Автоматизований торговий бот для Binance нових лістингів
 */

import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

// Встановлення __dirname для ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Імпорти основних модулів
import logger from './utils/logger.js';
import { validateEnvironmentVariables } from './utils/validators.js';
import { getDatabase, initializeDatabase } from './database/init.js';
import { TradingEngine } from './simulation/tradingEngine.js';
import { TradingSimulator } from './simulation/simulator.js';
import { ParameterOptimizer } from './analysis/optimizer.js';
import { NewListingScalperStrategy } from './simulation/strategies/newListingScalper.js';

// Глобальні змінні
let tradingEngine = null;
let isShuttingDown = false;
const startTime = Date.now();

/**
 * Головна функція додатку
 */
async function main() {
  try {
    // Вітаємо користувача
    displayWelcomeMessage();
    
    // Валідація змінних середовища
    await validateEnvironment();
    
    // Ініціалізація бази даних
    await initializeDatabase();
    
    // Визначення режиму роботи
    const mode = process.argv[2] || 'help';
    
    switch (mode.toLowerCase()) {
      case 'trade':
        await startTradingMode();
        break;
      case 'simulate':
        await startSimulationMode();
        break;
      case 'optimize':
        await startOptimizationMode();
        break;
      case 'backtest':
        await startBacktestMode();
        break;
      case 'status':
        await showStatus();
        break;
      case 'balance':
        await showBalance();
        break;
      case 'help':
      default:
        showHelp();
        break;
    }
    
  } catch (error) {
    logger.error('Critical error in main function:', error);
    process.exit(1);
  }
}

/**
 * Показ вітального повідомлення
 */
function displayWelcomeMessage() {
  const version = getVersion();
  const environment = process.env.BOT_ENV || 'development';
  
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                  🚀 BINANCE TRADING BOT 🚀                   ║
║                                                              ║
║  Автоматизований торговий бот для нових лістингів Binance    ║
║                                                              ║
║  Версія: ${version.padEnd(51)}║
║  Середовище: ${environment.padEnd(47)}║
║  Запущено: ${new Date().toLocaleString('uk-UA').padEnd(49)}║
╚══════════════════════════════════════════════════════════════╝
  `);
}

/**
 * Отримання версії з package.json
 */
function getVersion() {
  try {
    const packagePath = join(__dirname, '../package.json');
    const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return packageData.version || '1.0.0';
  } catch (error) {
    return '1.0.0';
  }
}

/**
 * Валідація змінних середовища
 */
async function validateEnvironment() {
  logger.info('🔍 Validating environment variables...');
  
  const validation = validateEnvironmentVariables(process.env);
  
  if (!validation.isValid) {
    logger.error('❌ Environment validation failed:');
    validation.errors.forEach(error => logger.error(`   - ${error}`));
    process.exit(1);
  }
  
  if (validation.warnings && validation.warnings.length > 0) {
    logger.warn('⚠️  Environment warnings:');
    validation.warnings.forEach(warning => logger.warn(`   - ${warning}`));
  }
  
  logger.info('✅ Environment validation passed');
}

/**
 * Режим реальної торгівлі
 */
async function startTradingMode() {
  logger.info('🎯 Starting trading mode...');
  
  try {
    // Створення торгового движка
    const config = createTradingConfig();
    tradingEngine = new TradingEngine(config);
    
    // Запуск движка
    await tradingEngine.start();
    
    logger.info('✅ Trading engine started successfully');
    logger.info('📊 Bot is now scanning for new listings...');
    
    // Показ статистики кожні 30 секунд
    const statsInterval = setInterval(() => {
      if (!isShuttingDown) {
        const stats = tradingEngine.getStats();
        logger.info(`📈 Stats: Balance: ${stats.currentBalance} USDT | Active: ${stats.activeTrades} | Total: ${stats.totalTrades}`);
      }
    }, 30000);
    
    // Очистка інтервалу при зупинці
    process.on('SIGTERM', () => clearInterval(statsInterval));
    process.on('SIGINT', () => clearInterval(statsInterval));
    
  } catch (error) {
    logger.error('❌ Failed to start trading mode:', error);
    process.exit(1);
  }
}

/**
 * Режим симуляції
 */
async function startSimulationMode() {
  logger.info('🎮 Starting simulation mode...');
  
  try {
    const daysBack = parseInt(process.argv[3]) || 30;
    const configName = process.argv[4] || 'Default Simulation';
    
    logger.info(`📊 Running simulation for last ${daysBack} days`);
    
    const config = createSimulationConfig(configName);
    const simulator = new TradingSimulator(config);
    
    const results = await simulator.runSimulation(daysBack);
    
    // Показ результатів
    displaySimulationResults(results);
    
  } catch (error) {
    logger.error('❌ Simulation failed:', error);
    process.exit(1);
  }
}

/**
 * Режим оптимізації параметрів
 */
async function startOptimizationMode() {
  logger.info('🔧 Starting parameter optimization...');
  
  try {
    const iterations = parseInt(process.argv[3]) || 50;
    
    logger.info(`🎯 Running optimization with ${iterations} iterations`);
    
    const baseConfig = createSimulationConfig('Optimization Base');
    const optimizer = new ParameterOptimizer();
    
    const optimizationParams = {
      takeProfitRange: [0.5, 3.0, 0.5],
      stopLossRange: [0.5, 2.0, 0.5],
      trailingStopRange: [0.2, 1.0, 0.2],
      buyAmountRange: [50, 200, 50],
      maxIterations: iterations,
      targetMetric: 'roi_percent'
    };
    
    const bestConfigs = await optimizer.optimize(baseConfig, optimizationParams);
    
    // Показ результатів оптимізації
    displayOptimizationResults(bestConfigs);
    
  } catch (error) {
    logger.error('❌ Optimization failed:', error);
    process.exit(1);
  }
}

/**
 * Режим бектестингу
 */
async function startBacktestMode() {
  logger.info('📈 Starting backtest mode...');
  
  try {
    const daysBack = parseInt(process.argv[3]) || 180;
    const configFile = process.argv[4];
    
    let config;
    if (configFile) {
      // Завантаження конфігурації з файлу
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } else {
      config = createSimulationConfig('Backtest');
    }
    
    logger.info(`📊 Running backtest for last ${daysBack} days`);
    
    const simulator = new TradingSimulator(config);
    const results = await simulator.runSimulation(daysBack);
    
    // Детальний звіт
    displayBacktestResults(results);
    
    // Експорт результатів
    const exportFile = `backtest_${Date.now()}.json`;
    fs.writeFileSync(exportFile, JSON.stringify(simulator.exportData(), null, 2));
    logger.info(`📄 Results exported to: ${exportFile}`);
    
  } catch (error) {
    logger.error('❌ Backtest failed:', error);
    process.exit(1);
  }
}

/**
 * Показ поточного статусу
 */
async function showStatus() {
  try {
    const db = getDatabase();
    
    // Інформація про базу даних
    const symbolsCount = db.prepare('SELECT COUNT(*) as count FROM symbols').get().count;
    const configsCount = db.prepare('SELECT COUNT(*) as count FROM simulation_configs').get().count;
    const resultsCount = db.prepare('SELECT COUNT(*) as count FROM simulation_results').get().count;
    
    // Останні результати
    const latestResults = db.prepare(`
      SELECT sc.name, ss.roi_percent, ss.win_rate_percent, ss.total_trades
      FROM simulation_summary ss
      JOIN simulation_configs sc ON ss.config_id = sc.id
      ORDER BY ss.simulation_date DESC
      LIMIT 5
    `).all();
    
    console.log(`
📊 СИСТЕМНИЙ СТАТУС
═══════════════════════════════════════════
🗄️  База даних:
   • Символів: ${symbolsCount}
   • Конфігурацій: ${configsCount}  
   • Результатів: ${resultsCount}

📈 Останні симуляції:
${latestResults.map(r => 
  `   • ${r.name}: ROI ${r.roi_percent}% | Win Rate ${r.win_rate_percent}% | Trades ${r.total_trades}`
).join('\n')}

🔧 Середовище: ${process.env.BOT_ENV || 'development'}
⏱️  Uptime: ${Math.round((Date.now() - startTime) / 1000)}s
    `);
    
  } catch (error) {
    logger.error('❌ Failed to get status:', error);
  }
}

/**
 * Показ балансу акаунта
 */
async function showBalance() {
  try {
    // В реальному проекті тут би був виклик API
    const balance = process.env.INITIAL_BALANCE_USDT || '10000';
    
    console.log(`
💰 БАЛАНС АКАУНТА
═══════════════════════════════════════════
💵 USDT: ${balance}
🏦 Режим: ${process.env.BINANCE_TESTNET === 'true' ? 'Testnet' : 'Mainnet'}
    `);
    
  } catch (error) {
    logger.error('❌ Failed to get balance:', error);
  }
}

/**
 * Показ довідки
 */
function showHelp() {
  console.log(`
📖 ДОВІДКА КОМАНД
═══════════════════════════════════════════

🎯 Режими роботи:
   node src/index.js trade                    - Запуск реальної торгівлі
   node src/index.js simulate [days] [name]   - Симуляція (за замовчуванням 30 днів)
   node src/index.js optimize [iterations]    - Оптимізація параметрів (за замовчуванням 50)
   node src/index.js backtest [days] [config] - Детальний бектест
   node src/index.js status                   - Показ статусу системи
   node src/index.js balance                  - Показ балансу акаунта
   node src/index.js help                     - Ця довідка

📚 Приклади:
   npm run start                              - Запуск в режимі торгівлі (testnet)
   node src/index.js simulate 90              - Симуляція за 90 днів
   node src/index.js optimize 100             - Оптимізація з 100 ітерацій
   node src/index.js backtest 180 config.json - Бектест з користувацькою конфігурацією

🔧 Змінні середовища:
   BOT_ENV=testnet|main|mynet                 - Вибір середовища
   BINANCE_API_KEY                            - API ключ Binance
   BINANCE_API_SECRET                         - Секретний ключ Binance
   INITIAL_BALANCE_USDT                       - Початковий баланс для симуляції

📝 Конфігурація:
   Налаштуйте файли .env.testnet, .env.main, .env.mynet
   Скопіюйте .env.example як шаблон
  `);
}

/**
 * Створення конфігурації для торгівлі
 */
function createTradingConfig() {
  return {
    name: 'Live Trading',
    simulationMode: false,
    
    // Торгові параметри
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) || 2.0,
    stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT) || 1.0,
    trailingStopEnabled: process.env.TRAILING_STOP_ENABLED === 'true',
    trailingStopPercent: parseFloat(process.env.TRAILING_STOP_PERCENT) || 0.5,
    trailingStopActivationPercent: parseFloat(process.env.TRAILING_STOP_ACTIVATION_PERCENT) || 1.0,
    
    // Розміри позицій
    buyAmountUsdt: parseFloat(process.env.BUY_AMOUNT_USDT) || 100,
    maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES) || 3,
    
    // Фільтри ліквідності
    minLiquidityUsdt: parseFloat(process.env.MIN_LIQUIDITY_USDT) || 10000,
    maxPriceImpact: parseFloat(process.env.MAX_PRICE_IMPACT) || 0.5,
    
    // Комісії та таймінги
    binanceFeePercent: 0.1,
    cooldownSeconds: parseInt(process.env.COOLDOWN_SECONDS) || 300,
    maxTradeTimeMinutes: parseInt(process.env.MAX_TRADE_TIME_MINUTES) || 15
  };
}

/**
 * Створення конфігурації для симуляції
 */
function createSimulationConfig(name) {
  return {
    name,
    simulationMode: true,
    
    // Торгові параметри для симуляції
    takeProfitPercent: 1.5,
    stopLossPercent: 0.8,
    trailingStopEnabled: true,
    trailingStopPercent: 0.3,
    trailingStopActivationPercent: 0.8,
    
    // Розміри позицій
    buyAmountUsdt: 100,
    maxOpenTrades: 5,
    
    // Фільтри
    minLiquidityUsdt: 5000,
    maxPriceImpact: 1.0,
    
    // Налаштування симуляції
    binanceFeePercent: 0.1,
    cooldownSeconds: 180,
    maxTradeTimeMinutes: 10
  };
}

/**
 * Показ результатів симуляції
 */
function displaySimulationResults(results) {
  const { summary } = results;
  
  console.log(`
📊 РЕЗУЛЬТАТИ СИМУЛЯЦІЇ
═══════════════════════════════════════════
💰 Фінансові показники:
   • Початковий баланс: ${summary.initialBalance.toFixed(2)} USDT
   • Кінцевий баланс: ${summary.finalBalance.toFixed(2)} USDT
   • Загальний прибуток: ${summary.totalReturn.toFixed(2)} USDT
   • ROI: ${summary.roiPercent}%

📈 Торгові метрики:
   • Всього угод: ${summary.totalTrades}
   • Прибуткові: ${summary.profitableTrades}
   • Збиткові: ${summary.losingTrades}
   • Win Rate: ${summary.winRate}%

📉 Ризикові показники:
   • Максимальна просадка: ${summary.maxDrawdown}%
   • Profit Factor: ${summary.profitFactor}
   • Sharpe Ratio: ${summary.sharpeRatio}
   • Макс. послідовні збитки: ${summary.maxConsecutiveLosses}

💸 Витрати:
   • Загальний об'єм: ${summary.totalVolume.toFixed(2)} USDT
   • Комісії: ${summary.totalCommissions.toFixed(2)} USDT
  `);
}

/**
 * Показ результатів оптимізації
 */
function displayOptimizationResults(results) {
  console.log(`
🔧 РЕЗУЛЬТАТИ ОПТИМІЗАЦІЇ
═══════════════════════════════════════════`);
  
  results.slice(0, 5).forEach((result, index) => {
    const { config, performance } = result;
    console.log(`
${index + 1}. ${config.name}
   • Take Profit: ${config.takeProfitPercent}%
   • Stop Loss: ${config.stopLossPercent}%
   • Trailing Stop: ${config.trailingStopPercent}%
   • ROI: ${performance.roiPercent}%
   • Win Rate: ${performance.winRate}%
   • Trades: ${performance.totalTrades}`);
  });
}

/**
 * Показ детальних результатів бектесту
 */
function displayBacktestResults(results) {
  displaySimulationResults(results);
  
  const { summary } = results;
  
  console.log(`
📊 ДОДАТКОВА СТАТИСТИКА
═══════════════════════════════════════════
⏱️  Середній час угоди: ${summary.averageTradeTime} хв
🔄 Типи виходів:
   • Take Profit: ${summary.exitReasonStats.takeProfit}
   • Stop Loss: ${summary.exitReasonStats.stopLoss}
   • Trailing Stop: ${summary.exitReasonStats.trailingStop}
   • Timeout: ${summary.exitReasonStats.timeout}

📋 Технічні показники:
   • Оброблено лістингів: ${summary.processedListings}
   • Пропущено: ${summary.skippedListings}
   • Тривалість симуляції: ${Math.round(summary.simulationDuration / 1000)}s
  `);
}

/**
 * Graceful shutdown
 */
async function gracefulShutdown(signal) {
  logger.info(`📴 Received ${signal}. Starting graceful shutdown...`);
  isShuttingDown = true;
  
  try {
    if (tradingEngine) {
      logger.info('🔄 Stopping trading engine...');
      await tradingEngine.stop();
      logger.info('✅ Trading engine stopped');
    }
    
    // Закриття з'єднання з БД
    const db = getDatabase();
    if (db) {
      db.close();
      logger.info('✅ Database connection closed');
    }
    
    logger.info('✅ Graceful shutdown completed');
    process.exit(0);
    
  } catch (error) {
    logger.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
}

/**
 * Обробка помилок
 */
process.on('uncaughtException', (error) => {
  logger.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Graceful shutdown handlers
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Запуск додатку
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logger.error('❌ Fatal error:', error);
    process.exit(1);
  });
}