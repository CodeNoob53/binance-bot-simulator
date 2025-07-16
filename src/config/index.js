import 'dotenv/config';

export const config = {
  // Database
  dbPath: process.env.DB_PATH || './data/simulation.db',
  
  // Data collection
  workersCount: parseInt(process.env.WORKERS_COUNT) || 10,
  rateLimitDelayMs: parseInt(process.env.RATE_LIMIT_DELAY_MS) || 100,
  retryAttempts: parseInt(process.env.RETRY_ATTEMPTS) || 3,
  
  // Simulation
  initialBalanceUsdt: parseFloat(process.env.INITIAL_BALANCE_USDT) || 10000,
  defaultBuyAmountUsdt: parseFloat(process.env.DEFAULT_BUY_AMOUNT_USDT) || 50,
  defaultBinanceFeePercent: parseFloat(process.env.DEFAULT_BINANCE_FEE_PERCENT) || 0.00075,
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
  logFile: process.env.LOG_FILE || './logs/simulator.log',
  
  // Binance API
  binanceApiBaseUrl: process.env.BINANCE_API_BASE_URL || 'https://api.binance.com'
};

export default config;