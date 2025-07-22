/**
 * ВИПРАВЛЕНО: Валідація ринкових даних (більш терпима до різних форматів)
 */
export function validateMarketData(marketData) {
  const errors = [];
  
  if (!marketData || typeof marketData !== 'object') {
    errors.push('marketData must be an object');
    return { isValid: false, errors };
  }
  
  // Валідація символу (більш терпима)
  if (!marketData.symbol || typeof marketData.symbol !== 'string') {
    errors.push('symbol is required and must be a string');
  } else {
    // ВИПРАВЛЕНО: Більш терпимий regex для символів
    const symbolPattern = /^[A-Z0-9]{3,20}USDT$/;
    if (!symbolPattern.test(marketData.symbol)) {
      // Логуємо для діагностики, але не відхиляємо
      console.warn(`Symbol ${marketData.symbol} has unusual format but proceeding`);
    }
  }
  
  // Валідація ticker
  if (!marketData.ticker || typeof marketData.ticker !== 'object') {
    errors.push('ticker is required and must be an object');
  } else {
    if (!marketData.ticker.price) {
      errors.push('ticker.price is required');
    } else {
      const price = parseFloat(marketData.ticker.price);
      if (isNaN(price) || price <= 0) {
        errors.push('ticker.price must be a valid positive number');
      }
    }
    
    // ВИПРАВЛЕНО: priceChangePercent опціональний
    if (marketData.ticker.priceChangePercent !== undefined) {
      const priceChange = parseFloat(marketData.ticker.priceChangePercent);
      if (isNaN(priceChange)) {
        // Логуємо попередження, але не відхиляємо
        console.warn(`Invalid priceChangePercent for ${marketData.symbol}, setting to 0`);
        marketData.ticker.priceChangePercent = '0.00';
      }
    } else {
      // Встановлюємо значення за замовчуванням
      marketData.ticker.priceChangePercent = '0.00';
    }
    
    if (!marketData.ticker.volume) {
      errors.push('ticker.volume is required');
    } else {
      const volume = parseFloat(marketData.ticker.volume);
      if (isNaN(volume) || volume < 0) {
        errors.push('ticker.volume must be a valid non-negative number');
      }
    }
  }
  
  // Валідація klines
  if (!marketData.klines || !Array.isArray(marketData.klines)) {
    errors.push('klines is required and must be an array');
  } else if (marketData.klines.length === 0) {
    errors.push('klines array cannot be empty');
  } else {
    // Перевірка структури першої kline
    const firstKline = marketData.klines[0];
    if (!firstKline || typeof firstKline !== 'object') {
      errors.push('klines must contain valid kline objects');
    } else {
      const requiredKlineFields = ['open', 'high', 'low', 'close', 'volume'];
      for (const field of requiredKlineFields) {
        if (firstKline[field] === undefined) {
          errors.push(`kline must have ${field} field`);
        } else {
          const value = parseFloat(firstKline[field]);
          if (isNaN(value) || value < 0) {
            errors.push(`kline.${field} must be a valid non-negative number`);
          }
        }
      }
    }
  }
  
  // ВИПРАВЛЕНО: orderBook опціональний для симуляції
  if (marketData.orderBook) {
    if (typeof marketData.orderBook !== 'object') {
      errors.push('orderBook must be an object');
    } else {
      if (!marketData.orderBook.bids || !Array.isArray(marketData.orderBook.bids)) {
        errors.push('orderBook.bids is required and must be an array');
      }
      if (!marketData.orderBook.asks || !Array.isArray(marketData.orderBook.asks)) {
        errors.push('orderBook.asks is required and must be an array');
      }
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Валідація конфігурації торгівлі
 */
export function validateConfig(config) {
  const errors = [];
  
  if (!config || typeof config !== 'object') {
    errors.push('config must be an object');
    return { isValid: false, errors };
  }
  
  // Валідація назви
  if (!config.name || typeof config.name !== 'string') {
    errors.push('config.name is required and must be a string');
  }
  
  // Валідація take profit
  if (config.takeProfitPercent !== undefined) {
    const tp = parseFloat(config.takeProfitPercent);
    if (isNaN(tp) || tp <= 0 || tp > 1) {
      errors.push('takeProfitPercent must be a number between 0 and 1');
    }
  }
  
  // Валідація stop loss
  if (config.stopLossPercent !== undefined) {
    const sl = parseFloat(config.stopLossPercent);
    if (isNaN(sl) || sl <= 0 || sl > 1) {
      errors.push('stopLossPercent must be a number between 0 and 1');
    }
  }
  
  // Перевірка логічності TP vs SL
  if (config.takeProfitPercent && config.stopLossPercent) {
    const tp = parseFloat(config.takeProfitPercent);
    const sl = parseFloat(config.stopLossPercent);
    if (tp <= sl) {
      errors.push('takeProfitPercent must be greater than stopLossPercent');
    }
  }
  
  // Валідація суми покупки
  if (config.buyAmountUsdt !== undefined) {
    const amount = parseFloat(config.buyAmountUsdt);
    if (isNaN(amount) || amount <= 0) {
      errors.push('buyAmountUsdt must be a positive number');
    }
  }
  
  // Валідація максимальних угод
  if (config.maxOpenTrades !== undefined) {
    const maxTrades = parseInt(config.maxOpenTrades);
    if (isNaN(maxTrades) || maxTrades <= 0 || maxTrades > 100) {
      errors.push('maxOpenTrades must be a positive integer <= 100');
    }
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
  
  // Валідація bids
  if (!orderBook.bids || !Array.isArray(orderBook.bids)) {
    errors.push('bids is required and must be an array');
  } else if (orderBook.bids.length === 0) {
    errors.push('bids array cannot be empty');
  } else {
    for (let i = 0; i < Math.min(5, orderBook.bids.length); i++) {
      const bid = orderBook.bids[i];
      if (!Array.isArray(bid) || bid.length < 2) {
        errors.push(`bid ${i} must be an array with at least 2 elements [price, quantity]`);
        continue;
      }
      
      const [price, quantity] = bid;
      if (isNaN(parseFloat(price)) || parseFloat(price) <= 0) {
        errors.push(`bid ${i} price must be a valid positive number`);
      }
      if (isNaN(parseFloat(quantity)) || parseFloat(quantity) <= 0) {
        errors.push(`bid ${i} quantity must be a valid positive number`);
      }
    }
  }
  
  // Валідація asks
  if (!orderBook.asks || !Array.isArray(orderBook.asks)) {
    errors.push('asks is required and must be an array');
  } else if (orderBook.asks.length === 0) {
    errors.push('asks array cannot be empty');
  } else {
    for (let i = 0; i < Math.min(5, orderBook.asks.length); i++) {
      const ask = orderBook.asks[i];
      if (!Array.isArray(ask) || ask.length < 2) {
        errors.push(`ask ${i} must be an array with at least 2 elements [price, quantity]`);
        continue;
      }
      
      const [price, quantity] = ask;
      if (isNaN(parseFloat(price)) || parseFloat(price) <= 0) {
        errors.push(`ask ${i} price must be a valid positive number`);
      }
      if (isNaN(parseFloat(quantity)) || parseFloat(quantity) <= 0) {
        errors.push(`ask ${i} quantity must be a valid positive number`);
      }
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Валідація результату торгівлі
 */
export function validateTradeResult(result) {
  const errors = [];
  
  if (!result || typeof result !== 'object') {
    errors.push('result must be an object');
    return { isValid: false, errors };
  }
  
  // Валідація символу
  if (!result.symbol || typeof result.symbol !== 'string') {
    errors.push('symbol is required and must be a string');
  }
  
  // Валідація часових міток
  if (!result.entryTime || typeof result.entryTime !== 'number') {
    errors.push('entryTime is required and must be a number');
  }
  
  if (result.exitTime && typeof result.exitTime !== 'number') {
    errors.push('exitTime must be a number');
  }
  
  if (result.entryTime && result.exitTime && result.exitTime <= result.entryTime) {
    errors.push('exitTime must be greater than entryTime');
  }
  
  // Валідація цін
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
  
  // Валідація quantity
  if (!result.quantity || typeof result.quantity !== 'number') {
    errors.push('quantity is required and must be a number');
  } else if (result.quantity <= 0) {
    errors.push('quantity must be greater than 0');
  }
  
  // Валідація exitReason
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
 * Валідація торгової угоди
 */
export function validateTrade(trade) {
  const errors = [];
  
  if (!trade || typeof trade !== 'object') {
    errors.push('trade must be an object');
    return { isValid: false, errors };
  }
  
  // Валідація символу
  if (!trade.symbol || typeof trade.symbol !== 'string') {
    errors.push('symbol is required and must be a string');
  }
  
  // Валідація сторони угоди
  const validSides = ['BUY', 'SELL'];
  if (!trade.side || !validSides.includes(trade.side)) {
    errors.push(`side must be one of: ${validSides.join(', ')}`);
  }
  
  // Валідація типу угоди
  const validTypes = ['MARKET', 'LIMIT', 'STOP_LOSS', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT', 'TAKE_PROFIT_LIMIT'];
  if (!trade.type || !validTypes.includes(trade.type)) {
    errors.push(`type must be one of: ${validTypes.join(', ')}`);
  }
  
  // Валідація кількості
  if (!trade.quantity || typeof trade.quantity !== 'number') {
    errors.push('quantity is required and must be a number');
  } else if (trade.quantity <= 0) {
    errors.push('quantity must be greater than 0');
  }
  
  // Валідація ціни (для лімітних ордерів)
  if (trade.type && (trade.type.includes('LIMIT') || trade.type.includes('STOP'))) {
    if (!trade.price || typeof trade.price !== 'number') {
      errors.push('price is required for limit and stop orders');
    } else if (trade.price <= 0) {
      errors.push('price must be greater than 0');
    }
  }
  
  // Валідація stopPrice (для стоп ордерів)
  if (trade.type && trade.type.includes('STOP')) {
    if (!trade.stopPrice || typeof trade.stopPrice !== 'number') {
      errors.push('stopPrice is required for stop orders');
    } else if (trade.stopPrice <= 0) {
      errors.push('stopPrice must be greater than 0');
    }
  }
  
  // Валідація timeInForce
  if (trade.timeInForce) {
    const validTimeInForce = ['GTC', 'IOC', 'FOK'];
    if (!validTimeInForce.includes(trade.timeInForce)) {
      errors.push(`timeInForce must be one of: ${validTimeInForce.join(', ')}`);
    }
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
  
  // Валідація діапазонів
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
        continue;
      }
      
      if (min >= max) {
        errors.push(`${rangeName} min must be less than max`);
      }
      
      if (step <= 0) {
        errors.push(`${rangeName} step must be positive`);
      }
      
      if (step >= (max - min)) {
        errors.push(`${rangeName} step must be smaller than range`);
      }
    }
  }
  
  // Валідація maxIterations
  if (params.maxIterations !== undefined) {
    const iterations = parseInt(params.maxIterations);
    if (isNaN(iterations) || iterations <= 0 || iterations > 10000) {
      errors.push('maxIterations must be a positive integer <= 10000');
    }
  }
  
  // Валідація targetMetric
  const validMetrics = ['roi_percent', 'win_rate_percent', 'sharpe_ratio', 'profit_factor'];
  if (params.targetMetric && !validMetrics.includes(params.targetMetric)) {
    errors.push(`targetMetric must be one of: ${validMetrics.join(', ')}`);
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Валідація змінних середовища
 */
export function validateEnvironmentVariables(env) {
  const errors = [];
  const warnings = [];
  
  if (!env || typeof env !== 'object') {
    errors.push('Environment object is required');
    return { isValid: false, errors, warnings };
  }
  
  // Критичні змінні середовища
  const requiredVars = [
    'BOT_ENV',
    'DB_PATH',
    'INITIAL_BALANCE_USDT',
    'BINANCE_API_BASE_URL'
  ];
  
  for (const varName of requiredVars) {
    if (!env[varName]) {
      errors.push(`${varName} environment variable is required`);
    }
  }
  
  // Валідація BOT_ENV
  if (env.BOT_ENV) {
    const validEnvs = ['development', 'production', 'test'];
    if (!validEnvs.includes(env.BOT_ENV)) {
      warnings.push(`BOT_ENV should be one of: ${validEnvs.join(', ')}`);
    }
  }
  
  // Валідація INITIAL_BALANCE_USDT
  if (env.INITIAL_BALANCE_USDT) {
    const balance = parseFloat(env.INITIAL_BALANCE_USDT);
    if (isNaN(balance) || balance <= 0) {
      errors.push('INITIAL_BALANCE_USDT must be a positive number');
    } else if (balance < 10) {
      warnings.push('INITIAL_BALANCE_USDT is very low (< $10)');
    }
  }
  
  // Валідація DB_PATH
  if (env.DB_PATH && !env.DB_PATH.endsWith('.db')) {
    warnings.push('DB_PATH should end with .db extension');
  }
  
  // Валідація BINANCE_API_BASE_URL
  if (env.BINANCE_API_BASE_URL) {
    try {
      new URL(env.BINANCE_API_BASE_URL);
    } catch (error) {
      errors.push('BINANCE_API_BASE_URL must be a valid URL');
    }
  }
  
  // Опціональні змінні з попередженнями
  const optionalVars = {
    'LOG_LEVEL': ['error', 'warn', 'info', 'debug'],
    'MAX_CONCURRENT_REQUESTS': null,
    'REQUEST_TIMEOUT_MS': null
  };
  
  for (const [varName, validValues] of Object.entries(optionalVars)) {
    if (env[varName]) {
      if (validValues && !validValues.includes(env[varName])) {
        warnings.push(`${varName} should be one of: ${validValues.join(', ')}`);
      }
      
      if (varName === 'MAX_CONCURRENT_REQUESTS' || varName === 'REQUEST_TIMEOUT_MS') {
        const value = parseInt(env[varName]);
        if (isNaN(value) || value <= 0) {
          warnings.push(`${varName} should be a positive integer`);
        }
      }
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}