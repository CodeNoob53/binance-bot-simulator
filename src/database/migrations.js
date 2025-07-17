import logger from '../utils/logger.js';

export async function runMigrations(db) {
  logger.info('Running database migrations...');
  
  // Створюємо таблиці
  await db.exec(`
    -- Таблиця символів
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL UNIQUE,
      base_asset TEXT NOT NULL,
      quote_asset TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );
    
    CREATE INDEX IF NOT EXISTS idx_symbols_quote_asset ON symbols(quote_asset);
    CREATE INDEX IF NOT EXISTS idx_symbols_status ON symbols(status);
    
    -- Таблиця аналізу лістингів
    CREATE TABLE IF NOT EXISTS listing_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol_id INTEGER NOT NULL,
      listing_date INTEGER,
      data_status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      analysis_date INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      retry_count INTEGER DEFAULT 0,
      FOREIGN KEY (symbol_id) REFERENCES symbols(id),
      UNIQUE(symbol_id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_listing_analysis_status ON listing_analysis(data_status);
    CREATE INDEX IF NOT EXISTS idx_listing_analysis_listing_date ON listing_analysis(listing_date);
    
    -- Таблиця історичних даних
    CREATE TABLE IF NOT EXISTS historical_klines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol_id INTEGER NOT NULL,
      open_time INTEGER NOT NULL,
      close_time INTEGER NOT NULL,
      open_price REAL NOT NULL,
      high_price REAL NOT NULL,
      low_price REAL NOT NULL,
      close_price REAL NOT NULL,
      volume REAL NOT NULL,
      quote_asset_volume REAL NOT NULL,
      number_of_trades INTEGER NOT NULL,
      taker_buy_base_asset_volume REAL NOT NULL,
      taker_buy_quote_asset_volume REAL NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (symbol_id) REFERENCES symbols(id),
      UNIQUE(symbol_id, open_time)
    );
    
    CREATE INDEX IF NOT EXISTS idx_klines_symbol_time ON historical_klines(symbol_id, open_time);
    CREATE INDEX IF NOT EXISTS idx_klines_open_time ON historical_klines(open_time);
    
    -- Таблиця конфігурацій симуляції
    CREATE TABLE IF NOT EXISTS simulation_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      take_profit_percent REAL NOT NULL,
      stop_loss_percent REAL NOT NULL,
      trailing_stop_enabled INTEGER NOT NULL DEFAULT 0,
      trailing_stop_percent REAL,
      trailing_stop_activation_percent REAL,
      buy_amount_usdt REAL NOT NULL,
      max_open_trades INTEGER NOT NULL,
      min_liquidity_usdt REAL NOT NULL,
      binance_fee_percent REAL NOT NULL,
      cooldown_seconds INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );
    
    -- Таблиця результатів симуляції
    CREATE TABLE IF NOT EXISTS simulation_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      entry_time INTEGER NOT NULL,
      entry_price REAL NOT NULL,
      exit_time INTEGER,
      exit_price REAL,
      exit_reason TEXT,
      quantity REAL NOT NULL,
      profit_loss_usdt REAL,
      profit_loss_percent REAL,
      buy_commission REAL NOT NULL,
      sell_commission REAL,
      max_price_reached REAL,
      min_price_reached REAL,
      trailing_stop_triggered INTEGER DEFAULT 0,
      simulation_date INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (config_id) REFERENCES simulation_configs(id),
      FOREIGN KEY (symbol_id) REFERENCES symbols(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_simulation_results_config ON simulation_results(config_id);
    CREATE INDEX IF NOT EXISTS idx_simulation_results_symbol ON simulation_results(symbol_id);
    CREATE INDEX IF NOT EXISTS idx_simulation_results_entry_time ON simulation_results(entry_time);
    
    -- Таблиця зведеної статистики
    CREATE TABLE IF NOT EXISTS simulation_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id INTEGER NOT NULL,
      total_trades INTEGER NOT NULL,
      profitable_trades INTEGER NOT NULL,
      losing_trades INTEGER NOT NULL,
      timeout_trades INTEGER NOT NULL,
      trailing_stop_trades INTEGER NOT NULL DEFAULT 0,
      total_profit_usdt REAL NOT NULL,
      total_loss_usdt REAL NOT NULL,
      net_profit_usdt REAL NOT NULL,
      win_rate_percent REAL NOT NULL,
      avg_profit_percent REAL NOT NULL,
      avg_loss_percent REAL NOT NULL,
      max_profit_percent REAL NOT NULL,
      max_loss_percent REAL NOT NULL,
      avg_trade_duration_minutes REAL NOT NULL,
      total_simulation_period_days INTEGER NOT NULL,
      roi_percent REAL NOT NULL,
      sharpe_ratio REAL,
      max_drawdown_percent REAL,
      simulation_date INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (config_id) REFERENCES simulation_configs(id)
    );
  `);
  
  logger.info('Database migrations completed successfully');
}
