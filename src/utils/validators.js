/**
 * Модуль валідаторів для торгового бота
 * Містить функції для валідації різних типів даних
 */

/**
 * Валідація конфігурації торгового бота
 */
export function validateConfig(config) {
  const errors = [];
  
  // Перевірка обов'язкових полів
  if (!config.name || typeof config.name !== 'string') {
    errors.push('name is required and must be a string');
  }
  
  if (!config.takeProfitPercent || typeof config.takeProfitPercent !== 'number') {
    errors.push('takeProfitPercent is required and must be a number');
  } else if (config.takeProfitPercent <= 0 || config.takeProfitPercent > 100) {
    errors.push('takeProfitPercent must be between 0 and 100');
  }
  
  if (!config.stopLossPercent || typeof config.stopLossPercent !== 'number') {
    errors.push('stopLossPercent is required and must be a number');
  } else if (config.stopLossPercent <= 0 || config.stopLossPercent > 100) {
    errors.push('stopLossPercent must be between 0 and 100');
  }
  
  if (!config.buyAmountUsdt || typeof config.buyAmountUsdt !== 'number') {
    errors.push('buyAmountUsdt is required and must be a number');
  } else if (config.buyAmountUsdt <= 0) {
    errors.push('buyAmountUsdt must be greater than 0');
  }
  
  if (!config.maxOpenTrades || typeof config.maxOpenTrades !== 'number') {
    errors.push('maxOpenTrades is required and must be a number');
  } else if (config.maxOpenTrades <= 0 || config.maxOpenTrades > 50) {
    errors.push('maxOpenTrades must be between 1 and 50');
  }
  
  // Логічна перевірка
  if (config.takeProfitPercent && config.stopLossPercent && 
      config.takeProfitPercent <= config.stopLossPercent) {
    errors.push('takeProfitPercent must be greater than stopLossPercent');
  }
  
  // Trailing stop валідація
  if (config.trailingStopEnabled) {
    if (!config.trailingStopPercent || typeof config.trailingStopPercent !== 'number') {
      errors.push('trailingStopPercent is required when trailing stop is enabled');
    } else if (config.trailingStopPercent <= 0 || config.trailingStopPercent > 10) {
      errors.push('trailingStopPercent must be between 0 and 10');
    }
    
    if (config.trailingStopActivationPercent && 
        config.trailingStopActivationPercent >= config.takeProfitPercent) {
      errors.push('trailingStopActivationPercent must be less than takeProfitPercent');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Валідація ринкових даних
 */
export function validateMarketData(marketData) {
  const errors = [];
  
  if (!marketData || typeof marketData !== 'object') {
    errors.push('marketData must be an object');
    return { isValid: false, errors };
  }
  
  // Перевірка symbol
  if (!marketData.symbol || typeof marketData.symbol !== 'string') {
    errors.push('symbol is required and must be a string');
  } else if (!/^[A-Z]{2,10}USDT$/.test(marketData.symbol)) {
    errors.push('symbol must be in format "XXXUSDT"');
  }
  
  // Перевірка ticker
  if (!marketData.ticker || typeof marketData.ticker !== 'object') {
    errors.push('ticker is required and must be an object');
  } else {
    const tickerValidation = validateTicker(marketData.ticker);
    if (!tickerValidation.isValid) {
      errors.push(...tickerValidation.errors.map(e => `ticker.${e}`));
    }
  }
  
  // Перевірка orderBook
  if (marketData.orderBook) {
    const orderBookValidation = validateOrderBook(marketData.orderBook);
    if (!orderBookValidation.isValid) {
      errors.push(...orderBookValidation.errors.map(e => `orderBook.${e}`));
    }
  }
  
  // Перевірка klines
  if (marketData.klines && Array.isArray(marketData.klines)) {
    const klinesValidation = validateKlines(marketData.klines);
    if (!klinesValidation.isValid) {
      errors.push(...klinesValidation.errors.map(e => `klines.${e}`));
    }
  }
  
  // Перевірка часових міток
  if (marketData.listingDate && typeof marketData.listingDate !== 'number') {
    errors.push('listingDate must be a number (timestamp)');
  }
  
  if (marketData.currentTime && typeof marketData.currentTime !== 'number') {
    errors.push('currentTime must be a number (timestamp)');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Валідація ticker даних
 */
export function validateTicker(ticker) {
  const errors = [];
  
  if (!ticker || typeof ticker !== 'object') {
    errors.push('ticker must be an object');
    return { isValid: false, errors };
  }
  
  // Перевірка price
  if (!ticker.price) {
    errors.push('price is required');
  } else if (!isValidPrice(ticker.price)) {
    errors.push('price must be a valid number string');
  }
  
  // Перевірка volume
  if (ticker.volume && !isValidPrice(ticker.volume)) {
    errors.push('volume must be a valid number string');
  }
  
  // Перевірка priceChangePercent
  if (ticker.priceChangePercent && !isValidPrice(ticker.priceChangePercent)) {
    errors.push('priceChangePercent must be a valid number string');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Валідація order book
 */
export function validateOrderBook(orderBook) {
  const errors = [];
  
  if (!orderBook || typeof orderBook !== 'object') {
    errors.push('orderBook must be an object');
    return { isValid: false, errors };
  }
  
  // Перевірка bids
  if (!orderBook.bids || !Array.isArray(orderBook.bids)) {
    errors.push('bids is required and must be an array');
  } else {
    const bidsValidation = validateOrderBookSide(orderBook.bids, 'bids');
    if (!bidsValidation.isValid) {
      errors.push(...bidsValidation.errors);
    }
  }
  
  // Перевірка asks
  if (!orderBook.asks || !Array.isArray(orderBook.asks)) {
    errors.push('asks is required and must be an array');
  } else {
    const asksValidation = validateOrderBookSide(orderBook.asks, 'asks');
    if (!asksValidation.isValid) {
      errors.push(...asksValidation.errors);
    }
  }
  
  // Перевірка логічності цін
  if (orderBook.bids.length > 0 && orderBook.asks.length > 0) {
    const highestBid = parseFloat(orderBook.bids[0][0]);
    const lowestAsk = parseFloat(orderBook.asks[0][0]);
    
    if (highestBid >= lowestAsk) {
      errors.push('highest bid must be lower than lowest ask');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Валідація однієї сторони order book (bids або asks)
 */
function validateOrderBookSide(side, sideName) {
  const errors = [];
  
  if (side.length === 0) {
    errors.push(`${sideName} cannot be empty`);
    return { isValid: false, errors };
  }
  
  for (let i = 0; i < Math.min(side.length, 20); i++) {
    const order = side[i];
    
    if (!Array.isArray(order) || order.length !== 2) {
      errors.push(`${sideName}[${i}] must be an array with 2 elements [price, quantity]`);
      continue;
    }
    
    const [price, quantity] = order;
    
    if (!isValidPrice(price)) {
      errors.push(`${sideName}[${i}] price must be a valid number string`);
    }
    
    if (!isValidPrice(quantity)) {
      errors.push(`${sideName}[${i}] quantity must be a valid number string`);
    }
    
    // Перевірка сортування
    if (i > 0) {
      const prevPrice = parseFloat(side[i-1][0]);
      const currentPrice = parseFloat(price);
      
      if (sideName === 'bids' && currentPrice >= prevPrice) {
        errors.push(`${sideName} must be sorted in descending order by price`);
      } else if (sideName === 'asks' && currentPrice <= prevPrice) {
        errors.push(`${sideName} must be sorted in ascending order by price`);
      }
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Валідація klines (свічок)
 */
export function validateKlines(klines) {
  const errors = [];
  
  if (!Array.isArray(klines)) {
    errors.push('klines must be an array');
    return { isValid: false, errors };
  }
  
  if (klines.length === 0) {
    errors.push('klines cannot be empty');
    return { isValid: false, errors };
  }
  
  for (let i = 0; i < Math.min(klines.length, 10); i++) {
    const kline = klines[i];
    
    if (!kline || typeof kline !== 'object') {
      errors.push(`klines[${i}] must be an object`);
      continue;
    }
    
    // Перевірка обов'язкових полів
    const requiredFields = ['open', 'high', 'low', 'close', 'volume'];
    for (const field of requiredFields) {
      if (!kline[field]) {
        errors.push(`klines[${i}].${field} is required`);
      } else if (!isValidPrice(kline[field])) {
        errors.push(`klines[${i}].${field} must be a valid number string`);
      }
    }
    
    // Логічна перевірка цін
    if (kline.open && kline.high && kline.low && kline.close) {
      const open = parseFloat(kline.open);
      const high = parseFloat(kline.high);
      const low = parseFloat(kline.low);
      const close = parseFloat(kline.close);
      
      if (high < Math.max(open, close) || low > Math.min(open, close)) {
        errors.push(`klines[${i}] has invalid OHLC relationship`);
      }
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Валідація торгової угоди
 */
export function validateTrade(trade) {
  const errors = [];
  
  if (!trade || typeof trade !== 'object') {
    errors.push('trade must be an object');
    return { isValid: false, errors };
  }
  
  // Перевірка symbol
  if (!trade.symbol || typeof trade.symbol !== 'string') {
    errors.push('symbol is required and must be a string');
  }
  
  // Перевірка side
  if (!trade.side || !['BUY', 'SELL'].includes(trade.side)) {
    errors.push('side must be either "BUY" or "SELL"');
  }
  
  // Перевірка type
  if (!trade.type || !['MARKET', 'LIMIT', 'STOP_LOSS', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT', 'TAKE_PROFIT_LIMIT'].includes(trade.type)) {
    errors.push('type must be a valid order type');
  }
  
  // Перевірка quantity
  if (!trade.quantity) {
    errors.push('quantity is required');
  } else if (!isValidPrice(trade.quantity)) {
    errors.push('quantity must be a valid number string');
  } else if (parseFloat(trade.quantity) <= 0) {
    errors.push('quantity must be greater than 0');
  }
  
  // Перевірка price для LIMIT ордерів
  if (['LIMIT', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT_LIMIT'].includes(trade.type)) {
    if (!trade.price) {
      errors.push('price is required for limit orders');
    } else if (!isValidPrice(trade.price)) {
      errors.push('price must be a valid number string');
    } else if (parseFloat(trade.price) <= 0) {
      errors.push('price must be greater than 0');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Валідація результату симуляції
 */
export function validateSimulationResult(result) {
  const errors = [];
  
  if (!result || typeof result !== 'object') {
    errors.push('result must be an object');
    return { isValid: false, errors };
  }
  
  // Перевірка configId
  if (!result.configId || typeof result.configId !== 'number') {
    errors.push('configId is required and must be a number');
  }
  
  // Перевірка symbolId
  if (!result.symbolId || typeof result.symbolId !== 'number') {
    errors.push('symbolId is required and must be a number');
  }
  
  // Перевірка часових міток
  if (!result.entryTime || typeof result.entryTime !== 'number') {
    errors.push('entryTime is required and must be a number');
  }
  
  if (result.exitTime && typeof result.exitTime !== 'number') {
    errors.push('exitTime must be a number');
  }
  
  if (result.exitTime && result.entryTime && result.exitTime < result.entryTime) {
    errors.push('exitTime must be greater than entryTime');
  }
  
  // Перевірка цін
  if (!result.entryPrice || typeof result.entryPrice !== 'number') {
    errors.push('entryPrice is required and must be a number');
  } else if (result.entryPrice <= 0) {
    errors.push('entryPrice must be greater than 0');
  }
  
  if (result.exitPrice) {
    if (typeof result.exitPrice !== 'number') {
      errors.push('exitPrice must be a number');
    } else if (result.exitPrice <= 0) {
      errors.push('exitPrice must be greater than 0');
    }
  }
  
  // Перевірка quantity
  if (!result.quantity || typeof result.quantity !== 'number') {
    errors.push('quantity is required and must be a number');
  } else if (result.quantity <= 0) {
    errors.push('quantity must be greater than 0');
  }
  
  // Перевірка exitReason
  const validExitReasons = ['take_profit', 'stop_loss', 'trailing_stop', 'timeout', 'manual_close', 'engine_stopped'];
  if (result.exitReason && !validExitReasons.includes(result.exitReason)) {
    errors.push(`exitReason must be one of: ${validExitReasons.join(', ')}`);
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Валідація параметрів оптимізації
 */
export function validateOptimizationParams(params) {
  const errors = [];
  
  if (!params || typeof params !== 'object') {
    errors.push('params must be an object');
    return { isValid: false, errors };
  }
  
  // Перевірка діапазонів
  const ranges = ['takeProfitRange', 'stopLossRange', 'trailingStopRange', 'buyAmountRange'];
  
  for (const rangeName of ranges) {
    if (params[rangeName]) {
      const range = params[rangeName];
      
      if (!Array.isArray(range) || range.length !== 3) {
        errors.push(`${rangeName} must be an array with 3 elements [min, max, step]`);
        continue;
      }
      
      const [min, max, step] = range;
      
      if (typeof min !== 'number' || typeof max !== 'number' || typeof step !== 'number') {
        errors.push(`${rangeName} elements must be numbers`);
      } else if (min >= max) {
        errors.push(`${rangeName} min must be less than max`);
      } else if (step <= 0) {
        errors.push(`${rangeName} step must be greater than 0`);
      } else if (step > (max - min)) {
        errors.push(`${rangeName} step cannot be greater than (max - min)`);
      }
    }
  }
  
  // Перевірка maxIterations
  if (params.maxIterations && (typeof params.maxIterations !== 'number' || params.maxIterations <= 0)) {
    errors.push('maxIterations must be a positive number');
  }
  
  // Перевірка targetMetric
  const validMetrics = ['roi_percent', 'win_rate_percent', 'sharpe_ratio', 'total_profit', 'max_drawdown'];
  if (params.targetMetric && !validMetrics.includes(params.targetMetric)) {
    errors.push(`targetMetric must be one of: ${validMetrics.join(', ')}`);
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Валідація API ключів
 */
export function validateApiKeys(apiKeys) {
  const errors = [];
  
  if (!apiKeys || typeof apiKeys !== 'object') {
    errors.push('apiKeys must be an object');
    return { isValid: false, errors };
  }
  
  // Перевірка API key
  if (!apiKeys.apiKey || typeof apiKeys.apiKey !== 'string') {
    errors.push('apiKey is required and must be a string');
  } else if (apiKeys.apiKey.length < 32) {
    errors.push('apiKey appears to be too short');
  }
  
  // Перевірка secret key
  if (!apiKeys.apiSecret || typeof apiKeys.apiSecret !== 'string') {
    errors.push('apiSecret is required and must be a string');
  } else if (apiKeys.apiSecret.length < 32) {
    errors.push('apiSecret appears to be too short');
  }
  
  // Перевірка testnet прапорця
  if (apiKeys.testnet !== undefined && typeof apiKeys.testnet !== 'boolean') {
    errors.push('testnet must be a boolean');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Валідація налаштувань сповіщень
 */
export function validateNotificationSettings(settings) {
  const errors = [];
  
  if (!settings || typeof settings !== 'object') {
    errors.push('settings must be an object');
    return { isValid: false, errors };
  }
  
  // Telegram налаштування
  if (settings.telegram && settings.telegram.enabled) {
    if (!settings.telegram.botToken || typeof settings.telegram.botToken !== 'string') {
      errors.push('telegram.botToken is required when telegram notifications are enabled');
    }
    
    if (!settings.telegram.chatId || typeof settings.telegram.chatId !== 'string') {
      errors.push('telegram.chatId is required when telegram notifications are enabled');
    }
  }
  
  // Email налаштування
  if (settings.email && settings.email.enabled) {
    if (!settings.email.from || typeof settings.email.from !== 'string') {
      errors.push('email.from is required when email notifications are enabled');
    } else if (!isValidEmail(settings.email.from)) {
      errors.push('email.from must be a valid email address');
    }
    
    if (!settings.email.to || typeof settings.email.to !== 'string') {
      errors.push('email.to is required when email notifications are enabled');
    } else if (!isValidEmail(settings.email.to)) {
      errors.push('email.to must be a valid email address');
    }
    
    if (!settings.email.smtp || typeof settings.email.smtp !== 'object') {
      errors.push('email.smtp configuration is required when email notifications are enabled');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Перевірка чи рядок є валідною ціною/числом
 */
function isValidPrice(value) {
  if (typeof value === 'number') {
    return !isNaN(value) && isFinite(value) && value >= 0;
  }
  
  if (typeof value === 'string') {
    const num = parseFloat(value);
    return !isNaN(num) && isFinite(num) && num >= 0 && /^\d+\.?\d*$/.test(value);
  }
  
  return false;
}

/**
 * Перевірка валідності email адреси
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Валідація змінних середовища
 */
export function validateEnvironmentVariables(env) {
  const errors = [];
  const warnings = [];
  
  // Обов'язкові змінні
  const required = [
    'BINANCE_API_KEY',
    'BINANCE_API_SECRET',
    'INITIAL_BALANCE_USDT'
  ];
  
  for (const variable of required) {
    if (!env[variable]) {
      errors.push(`${variable} is required`);
    }
  }
  
  // Валідація типів
  if (env.INITIAL_BALANCE_USDT && isNaN(parseFloat(env.INITIAL_BALANCE_USDT))) {
    errors.push('INITIAL_BALANCE_USDT must be a valid number');
  }
  
  if (env.BINANCE_TESTNET && !['true', 'false'].includes(env.BINANCE_TESTNET.toLowerCase())) {
    warnings.push('BINANCE_TESTNET should be "true" or "false"');
  }
  
  // Валідація API ключів
  if (env.BINANCE_API_KEY && env.BINANCE_API_KEY.length < 32) {
    warnings.push('BINANCE_API_KEY appears to be too short');
  }
  
  if (env.BINANCE_API_SECRET && env.BINANCE_API_SECRET.length < 32) {
    warnings.push('BINANCE_API_SECRET appears to be too short');
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Валідація структури бази даних
 */
export function validateDatabaseRecord(tableName, record) {
  const errors = [];
  
  if (!record || typeof record !== 'object') {
    errors.push('record must be an object');
    return { isValid: false, errors };
  }
  
  switch (tableName) {
    case 'symbols':
      if (!record.symbol || typeof record.symbol !== 'string') {
        errors.push('symbol is required and must be a string');
      }
      break;
      
    case 'simulation_configs':
      const configValidation = validateConfig(record);
      errors.push(...configValidation.errors);
      break;
      
    case 'simulation_results':
      const resultValidation = validateSimulationResult(record);
      errors.push(...resultValidation.errors);
      break;
      
    default:
      errors.push(`Unknown table: ${tableName}`);
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Комплексна валідація системи
 */
export function validateSystem(systemConfig) {
  const results = {
    config: validateConfig(systemConfig.config),
    apiKeys: validateApiKeys(systemConfig.apiKeys),
    notifications: validateNotificationSettings(systemConfig.notifications),
    environment: validateEnvironmentVariables(systemConfig.environment)
  };
  
  const allErrors = Object.values(results).flatMap(r => r.errors || []);
  const allWarnings = Object.values(results).flatMap(r => r.warnings || []);
  
  return {
    isValid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
    details: results
  };
}

export default {
  validateConfig,
  validateMarketData,
  validateTicker,
  validateOrderBook,
  validateKlines,
  validateTrade,
  validateSimulationResult,
  validateOptimizationParams,
  validateApiKeys,
  validateNotificationSettings,
  validateEnvironmentVariables,
  validateDatabaseRecord,
  validateSystem
};