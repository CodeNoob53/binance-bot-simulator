// src/api/binanceClient.js
import axios from 'axios';
import logger from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

class BinanceClient {
  constructor() {
    this.baseURL = process.env.BINANCE_API_BASE_URL || 'https://api.binance.com';
    this.rateLimitDelay = parseInt(process.env.RATE_LIMIT_DELAY_MS) || 300;
    this.retryAttempts = parseInt(process.env.RETRY_ATTEMPTS) || 5;
    this.requestCounter = 0;
    this.lastRequestTime = 0;
    
    // Налаштування axios з правильними таймаутами
    this.axios = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'binance-bot-simulator/1.0.0'
      },
      // Важливо: налаштування для правильної обробки помилок
      validateStatus: function (status) {
        // Дозволяємо обробку всіх статусів, включаючи помилки
        return status < 600;
      }
    });
  }
  
  /**
   * Правильна обробка помилок Binance API
   */
  parseApiError(error) {
    let errorInfo = {
      code: -9999,
      message: 'Unknown error',
      type: 'UNKNOWN',
      retryable: false
    };
    
    if (error.response) {
      const { status, data, headers } = error.response;
      errorInfo.httpStatus = status;
      
      // Логування заголовків для діагностики rate limits
      if (headers['x-mbx-used-weight']) {
        errorInfo.usedWeight = headers['x-mbx-used-weight'];
      }
      
      // Обробка різних форматів відповідей від Binance
      if (data) {
        if (typeof data === 'string') {
          errorInfo.message = data;
          errorInfo.type = 'STRING_RESPONSE';
        } else if (data.code !== undefined && data.msg !== undefined) {
          // Стандартний формат помилки Binance
          errorInfo.code = parseInt(data.code);
          errorInfo.message = data.msg;
          errorInfo.type = 'BINANCE_ERROR';
          
          // Визначаємо чи можна повторити запит
          errorInfo.retryable = this.isRetryableError(errorInfo.code);
          
        } else if (Array.isArray(data)) {
          // Іноді API повертає масив замість об'єкта
          errorInfo.message = `Unexpected array response: ${JSON.stringify(data.slice(0, 2))}`;
          errorInfo.type = 'ARRAY_RESPONSE';
          errorInfo.retryable = false;
          
        } else if (typeof data === 'object') {
          // Інший формат об'єкта
          errorInfo.message = `Unexpected object response: ${JSON.stringify(data).substring(0, 200)}`;
          errorInfo.type = 'OBJECT_RESPONSE';
          errorInfo.retryable = false;
        }
      }
      
      // HTTP статус коди
      if (status === 429) {
        errorInfo.type = 'RATE_LIMIT';
        errorInfo.retryable = true;
        errorInfo.code = -1003;
      } else if (status >= 500) {
        errorInfo.type = 'SERVER_ERROR';
        errorInfo.retryable = true;
      } else if (status === 400) {
        errorInfo.type = 'BAD_REQUEST';
        errorInfo.retryable = false;
      }
      
    } else if (error.request) {
      // Мережеві помилки
      errorInfo.type = 'NETWORK_ERROR';
      errorInfo.retryable = true;
      
      if (error.code === 'ECONNABORTED') {
        errorInfo.code = -1001;
        errorInfo.message = 'Request timeout';
      } else if (error.code === 'ENOTFOUND') {
        errorInfo.code = -1002;
        errorInfo.message = 'DNS resolution failed';
      } else if (error.code === 'ECONNREFUSED') {
        errorInfo.code = -1002;
        errorInfo.message = 'Connection refused';
      } else {
        errorInfo.message = error.message || 'Network error';
      }
    } else {
      // Інші помилки
      errorInfo.message = error.message || 'Request setup error';
      errorInfo.type = 'REQUEST_ERROR';
    }
    
    return errorInfo;
  }
  
  /**
   * Визначає чи можна повторити запит для даного коду помилки
   */
  isRetryableError(code) {
    const retryableCodes = [
      -1003, // WAF Limit (rate limit)
      -1001, // Request timeout
      -1002, // Network error
      -1016, // Service shutting down
      -1020, // This operation is not supported
    ];
    
    const nonRetryableCodes = [
      -1102, // Mandatory parameter empty or malformed
      -1121, // Invalid symbol
      -1013, // Invalid quantity
      -2010, // Order rejected
      -2011, // Order cancel rejected
      -1125, // Invalid listen key
    ];
    
    if (nonRetryableCodes.includes(code)) {
      return false;
    }
    
    if (retryableCodes.includes(code)) {
      return true;
    }
    
    // За замовчуванням повторюємо невідомі помилки
    return true;
  }
  
  /**
   * Логування API помилок з детальною інформацією
   */
  logApiError(errorInfo, context) {
    const logData = {
      request: this.requestCounter,
      context,
      error: {
        code: errorInfo.code,
        message: errorInfo.message,
        type: errorInfo.type,
        httpStatus: errorInfo.httpStatus,
        retryable: errorInfo.retryable,
        usedWeight: errorInfo.usedWeight
      }
    };
    
    if (errorInfo.type === 'RATE_LIMIT') {
      logger.warn('Rate limit exceeded', logData);
    } else if (errorInfo.type === 'NETWORK_ERROR') {
      logger.warn('Network error', logData);
    } else if (errorInfo.type === 'SERVER_ERROR') {
      logger.warn('Server error', logData);
    } else if (!errorInfo.retryable) {
      logger.error('Non-retryable API error', logData);
    } else {
      logger.warn('API error', logData);
    }
  }
  
  /**
   * Керування rate limit з адаптивною затримкою
   */
  async enforceRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.rateLimitDelay) {
      const waitTime = this.rateLimitDelay - timeSinceLastRequest;
      await sleep(waitTime);
    }
    
    this.lastRequestTime = Date.now();
  }
  
  /**
   * Основний метод для виконання API запитів з retry логікою
   */
  async request(endpoint, params = {}) {
    this.requestCounter++;
    const requestId = this.requestCounter;
    
    logger.debug(`[${requestId}] API Request: ${endpoint}`, {
      params: Object.keys(params),
      paramsCount: Object.keys(params).length
    });
    
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        await this.enforceRateLimit();
        
        const startTime = Date.now();
        const response = await this.axios.get(endpoint, { params });
        const duration = Date.now() - startTime;
        
        logger.debug(`[${requestId}] Success (${duration}ms)`, {
          status: response.status,
          dataSize: Array.isArray(response.data) ? response.data.length : typeof response.data
        });
        
        return response.data;
        
      } catch (error) {
        const errorInfo = this.parseApiError(error);
        
        this.logApiError(errorInfo, {
          endpoint,
          params: Object.keys(params),
          attempt,
          requestId
        });
        
        // Якщо помилка не підлягає повторенню
        if (!errorInfo.retryable) {
          throw new Error(`API Error (${errorInfo.code}): ${errorInfo.message}`);
        }
        
        // Якщо це остання спроба
        if (attempt === this.retryAttempts) {
          throw new Error(`API failed after ${this.retryAttempts} attempts. Last error (${errorInfo.code}): ${errorInfo.message}`);
        }
        
        // Розрахунок затримки перед повторенням
        let delayMs = Math.min(Math.pow(2, attempt) * 1000, 30000); // Максимум 30 секунд
        
        // Спеціальні затримки для різних типів помилок
        if (errorInfo.type === 'RATE_LIMIT') {
          delayMs = Math.max(delayMs, 10000); // Мінімум 10 секунд для rate limit
        } else if (errorInfo.type === 'SERVER_ERROR') {
          delayMs = Math.max(delayMs, 5000); // Мінімум 5 секунд для серверних помилок
        }
        
        logger.info(`[${requestId}] Retrying in ${delayMs}ms (attempt ${attempt + 1}/${this.retryAttempts})`);
        await sleep(delayMs);
      }
    }
  }
  
  /**
   * Отримання інформації про біржу
   */
  async getExchangeInfo() {
    return await this.request('/api/v3/exchangeInfo');
  }
  
  /**
   * Отримання klines з валідацією
   */
  async getKlines(symbol, interval, startTime, endTime, limit = 1000) {
    const params = {
      symbol,
      interval,
      limit
    };
    
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;
    
    try {
      const result = await this.request('/api/v3/klines', params);
      
      // Валідація відповіді
      if (!Array.isArray(result)) {
        throw new Error(`Expected array response, got ${typeof result}`);
      }
      
      // Валідація структури klines
      if (result.length > 0) {
        const invalidKlines = result.filter(kline => 
          !Array.isArray(kline) || kline.length < 11
        );
        
        if (invalidKlines.length > 0) {
          logger.warn(`Found ${invalidKlines.length} invalid klines for ${symbol}`);
          // Фільтруємо тільки валідні klines
          return result.filter(kline => Array.isArray(kline) && kline.length >= 11);
        }
      }
      
      return result;
      
    } catch (error) {
      logger.error(`Failed to fetch klines for ${symbol}:`, {
        symbol,
        interval,
        startTime: startTime ? new Date(startTime).toISOString() : null,
        endTime: endTime ? new Date(endTime).toISOString() : null,
        limit,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Збір історичних klines з покращеною логікою
   */
  async getHistoricalKlines(symbol, interval, startTime, endTime) {
    const allKlines = [];
    let currentStartTime = startTime;
    const MAX_KLINES = 1000;
    const MAX_ITERATIONS = 100; // Обмеження для запобігання нескінченним циклам
    let iterations = 0;
    
    logger.info(`Starting historical collection for ${symbol}:`, {
      interval,
      period: `${Math.round((endTime - startTime) / (1000 * 60 * 60))} hours`,
      from: new Date(startTime).toISOString(),
      to: new Date(endTime).toISOString()
    });
    
    while (currentStartTime < endTime && iterations < MAX_ITERATIONS) {
      iterations++;
      
      try {
        const klines = await this.getKlines(
          symbol, 
          interval, 
          currentStartTime, 
          endTime, 
          MAX_KLINES
        );
        
        if (!klines || klines.length === 0) {
          logger.debug(`No more data for ${symbol} from ${new Date(currentStartTime).toISOString()}`);
          break;
        }
        
        // Уникаємо дублювання останньої свічки при пагінації
        const klinesToAdd = klines.length === MAX_KLINES ? 
          klines.slice(0, -1) : klines;
        
        allKlines.push(...klinesToAdd);
        
        // Наступний batch
        const lastKline = klines[klines.length - 1];
        currentStartTime = lastKline[6] + 1; // closeTime + 1ms
        
        // Логування прогресу
        if (iterations % 10 === 0) {
          const progress = Math.round((currentStartTime - startTime) / (endTime - startTime) * 100);
          logger.debug(`${symbol} progress: ${progress}% (${allKlines.length} klines)`);
        }
        
      } catch (error) {
        logger.error(`Error collecting ${symbol} at iteration ${iterations}:`, {
          currentTime: new Date(currentStartTime).toISOString(),
          collected: allKlines.length,
          error: error.message
        });
        
        // Для rate limit - чекаємо і продовжуємо
        if (error.message.includes('-1003') || error.message.includes('rate limit')) {
          logger.warn(`Rate limit for ${symbol}, waiting 30s before continuing...`);
          await sleep(30000);
          continue;
        }
        
        // Для інших помилок - виходимо
        break;
      }
    }
    
    if (iterations >= MAX_ITERATIONS) {
      logger.warn(`Reached max iterations for ${symbol} (${MAX_ITERATIONS})`);
    }
    
    const coverage = allKlines.length > 0 && endTime > startTime ?
      Math.round(((allKlines[allKlines.length-1][6] - allKlines[0][0]) / (endTime - startTime)) * 100) : 0;
    
    logger.info(`Completed ${symbol} collection:`, {
      klines: allKlines.length,
      iterations,
      coverage: `${coverage}%`,
      status: allKlines.length > 0 ? 'success' : 'no_data'
    });
    
    return allKlines;
  }
  
  /**
   * Отримання 24h ticker
   */
  async get24hrTicker(symbol = null) {
    const endpoint = '/api/v3/ticker/24hr';
    const params = symbol ? { symbol } : {};
    return await this.request(endpoint, params);
  }
  
  /**
   * Отримання поточної ціни
   */
  async getSymbolPriceTicker(symbol = null) {
    const endpoint = '/api/v3/ticker/price';
    const params = symbol ? { symbol } : {};
    return await this.request(endpoint, params);
  }
  
  /**
   * Статистика клієнта
   */
  getStats() {
    return {
      totalRequests: this.requestCounter,
      rateLimitDelay: this.rateLimitDelay,
      retryAttempts: this.retryAttempts,
      baseURL: this.baseURL
    };
  }
}

// Singleton instance
let clientInstance = null;

export function getBinanceClient() {
  if (!clientInstance) {
    clientInstance = new BinanceClient();
  }
  return clientInstance;
}

export default getBinanceClient();