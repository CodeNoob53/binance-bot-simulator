import logger from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

/**
 * Binance API Rate Limit Manager
 * 
 * Binance Rate Limits (станом на 2024):
 * - REST API: 1200 requests per minute (20 req/sec)
 * - Weight-based: 6000 weight per minute
 * - IP-based: shared across all connections from same IP
 * - Order limits: 10 orders per second, 100,000 orders per 24h
 * 
 * Стратегія:
 * - Консервативний підхід: 15 req/sec (900 req/min)
 * - Адаптивне керування на основі заголовків відповіді
 * - Черга запитів з пріоритетами
 * - Автоматичне відновлення після rate limit
 */
export class BinanceRateLimitManager {
  constructor(options = {}) {
    // Базові налаштування
    this.maxRequestsPerMinute = options.maxRequestsPerMinute || 900; // Консервативно
    this.maxRequestsPerSecond = options.maxRequestsPerSecond || 15;
    this.maxWeight = options.maxWeight || 5000; // Консервативно від 6000
    
    // Розрахунок інтервалів
    this.minIntervalMs = Math.ceil(1000 / this.maxRequestsPerSecond);
    this.weightResetInterval = 60 * 1000; // 1 хвилина
    
    // Стан менеджера
    this.requestQueue = [];
    this.isProcessing = false;
    this.lastRequestTime = 0;
    this.currentWeight = 0;
    this.requestsThisMinute = 0;
    this.requestsThisSecond = 0;
    
    // Статистика
    this.stats = {
      totalRequests: 0,
      rateLimitHits: 0,
      averageWaitTime: 0,
      maxWaitTime: 0,
      rejectedRequests: 0,
      startTime: Date.now()
    };
    
    // Таймери для скидання лічильників
    this.setupResetTimers();
    
    // Адаптивні параметри
    this.adaptiveMode = options.adaptiveMode !== false;
    this.backoffMultiplier = 1.0;
    this.lastRateLimitTime = 0;
    
    logger.info('Binance Rate Limit Manager initialized', {
      maxRequestsPerMinute: this.maxRequestsPerMinute,
      maxRequestsPerSecond: this.maxRequestsPerSecond,
      minIntervalMs: this.minIntervalMs,
      adaptiveMode: this.adaptiveMode
    });
  }
  
  /**
   * Основний метод для виконання запиту з контролем rate limit
   */
  async executeRequest(requestFn, options = {}) {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const priority = options.priority || 'normal';
    const weight = options.weight || 1;
    const timeout = options.timeout || 30000;
    
    return new Promise((resolve, reject) => {
      const request = {
        id: requestId,
        fn: requestFn,
        weight,
        priority,
        timeout,
        createdAt: Date.now(),
        resolve,
        reject
      };
      
      // Додаємо до черги з урахуванням пріоритету
      this.addToQueue(request);
      
      // Запускаємо обробку черги
      this.processQueue();
    });
  }
  
  /**
   * Додавання запиту до черги з пріоритетом
   */
  addToQueue(request) {
    const priorityOrder = { high: 0, normal: 1, low: 2 };
    
    // Знаходимо правильну позицію для вставки
    let insertIndex = this.requestQueue.length;
    for (let i = 0; i < this.requestQueue.length; i++) {
      if (priorityOrder[request.priority] < priorityOrder[this.requestQueue[i].priority]) {
        insertIndex = i;
        break;
      }
    }
    
    this.requestQueue.splice(insertIndex, 0, request);
    
    logger.debug(`Request ${request.id} added to queue`, {
      priority: request.priority,
      weight: request.weight,
      queueLength: this.requestQueue.length,
      position: insertIndex
    });
  }
  
  /**
   * Обробка черги запитів
   */
  async processQueue() {
    if (this.isProcessing || this.requestQueue.length === 0) {
      return;
    }
    
    this.isProcessing = true;
    
    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();
      
      try {
        // Перевірка таймауту
        if (Date.now() - request.createdAt > request.timeout) {
          request.reject(new Error('Request timeout'));
          this.stats.rejectedRequests++;
          continue;
        }
        
        // Очікування дозволу на виконання
        await this.waitForPermission(request.weight);
        
        // Виконання запиту
        const startTime = Date.now();
        const result = await this.executeWithRetry(request);
        const waitTime = startTime - request.createdAt;
        
        // Оновлення статистики
        this.updateStats(waitTime);
        
        request.resolve(result);
        
      } catch (error) {
        logger.error(`Request ${request.id} failed:`, error.message);
        request.reject(error);
        
        // Обробка rate limit помилок
        if (this.isRateLimitError(error)) {
          await this.handleRateLimitError(error);
        }
      }
    }
    
    this.isProcessing = false;
  }
  
  /**
   * Очікування дозволу на виконання запиту
   */
  async waitForPermission(weight) {
    const now = Date.now();
    
    // Перевірка weight limit
    if (this.currentWeight + weight > this.maxWeight) {
      const waitTime = this.weightResetInterval - (now % this.weightResetInterval);
      logger.debug(`Weight limit reached, waiting ${waitTime}ms`);
      await sleep(waitTime);
      this.currentWeight = 0;
    }
    
    // Перевірка requests per minute
    if (this.requestsThisMinute >= this.maxRequestsPerMinute) {
      const waitTime = 60000 - (now % 60000);
      logger.debug(`Minute limit reached, waiting ${waitTime}ms`);
      await sleep(waitTime);
    }
    
    // Перевірка requests per second
    if (this.requestsThisSecond >= this.maxRequestsPerSecond) {
      const waitTime = 1000 - (now % 1000);
      logger.debug(`Second limit reached, waiting ${waitTime}ms`);
      await sleep(waitTime);
    }
    
    // Мінімальний інтервал між запитами
    const timeSinceLastRequest = now - this.lastRequestTime;
    const requiredInterval = this.minIntervalMs * this.backoffMultiplier;
    
    if (timeSinceLastRequest < requiredInterval) {
      const waitTime = requiredInterval - timeSinceLastRequest;
      logger.debug(`Minimum interval wait: ${waitTime}ms`);
      await sleep(waitTime);
    }
    
    // Оновлення лічильників
    this.currentWeight += weight;
    this.requestsThisMinute++;
    this.requestsThisSecond++;
    this.lastRequestTime = Date.now();
  }
  
  /**
   * Виконання запиту з retry логікою
   */
  async executeWithRetry(request, maxRetries = 3) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await request.fn();
        
        // Обробка заголовків відповіді для адаптивного керування
        if (result && result.headers) {
          this.processResponseHeaders(result.headers);
        }
        
        // Скидання backoff при успішному запиті
        if (this.backoffMultiplier > 1.0) {
          this.backoffMultiplier = Math.max(1.0, this.backoffMultiplier * 0.9);
          logger.debug(`Backoff reduced to ${this.backoffMultiplier.toFixed(2)}`);
        }
        
        return result;
        
      } catch (error) {
        lastError = error;
        
        if (this.isRateLimitError(error)) {
          if (attempt < maxRetries) {
            const waitTime = Math.pow(2, attempt) * 1000; // Exponential backoff
            logger.warn(`Rate limit hit, retrying in ${waitTime}ms (attempt ${attempt}/${maxRetries})`);
            await sleep(waitTime);
            continue;
          }
        } else if (!this.isRetryableError(error)) {
          // Не повторюємо не-ретрайабельні помилки
          throw error;
        }
        
        if (attempt < maxRetries) {
          const waitTime = attempt * 1000;
          logger.debug(`Request failed, retrying in ${waitTime}ms (attempt ${attempt}/${maxRetries})`);
          await sleep(waitTime);
        }
      }
    }
    
    throw lastError;
  }
  
  /**
   * Обробка заголовків відповіді для адаптивного керування
   */
  processResponseHeaders(headers) {
    if (!this.adaptiveMode) return;
    
    // Binance повертає ці заголовки:
    const usedWeight = parseInt(headers['x-mbx-used-weight-1m']) || 0;
    const orderCount = parseInt(headers['x-mbx-order-count-1m']) || 0;
    
    if (usedWeight > 0) {
      this.currentWeight = usedWeight;
      
      // Адаптивне керування на основі використаного weight
      const weightUsagePercent = (usedWeight / this.maxWeight) * 100;
      
      if (weightUsagePercent > 80) {
        this.backoffMultiplier = Math.min(3.0, this.backoffMultiplier * 1.2);
        logger.debug(`High weight usage (${weightUsagePercent.toFixed(1)}%), increasing backoff to ${this.backoffMultiplier.toFixed(2)}`);
      } else if (weightUsagePercent < 50 && this.backoffMultiplier > 1.0) {
        this.backoffMultiplier = Math.max(1.0, this.backoffMultiplier * 0.95);
        logger.debug(`Low weight usage (${weightUsagePercent.toFixed(1)}%), reducing backoff to ${this.backoffMultiplier.toFixed(2)}`);
      }
    }
    
    logger.debug('Response headers processed', {
      usedWeight,
      orderCount,
      currentBackoff: this.backoffMultiplier.toFixed(2)
    });
  }
  
  /**
   * Обробка rate limit помилки
   */
  async handleRateLimitError(error) {
    this.stats.rateLimitHits++;
    this.lastRateLimitTime = Date.now();
    
    // Збільшуємо backoff
    this.backoffMultiplier = Math.min(5.0, this.backoffMultiplier * 2.0);
    
    // Витягуємо час очікування з помилки, якщо доступно
    let retryAfter = 60000; // За замовчуванням 1 хвилина
    
    if (error.response && error.response.headers) {
      const retryAfterHeader = error.response.headers['retry-after'];
      if (retryAfterHeader) {
        retryAfter = parseInt(retryAfterHeader) * 1000;
      }
    }
    
    logger.warn(`Rate limit error handled`, {
      retryAfter,
      newBackoff: this.backoffMultiplier.toFixed(2),
      totalRateLimitHits: this.stats.rateLimitHits
    });
    
    // Очікуємо перед продовженням
    await sleep(retryAfter);
  }
  
  /**
   * Перевірка чи є помилка rate limit
   */
  isRateLimitError(error) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      
      // HTTP 429 або Binance код -1003
      return status === 429 || 
             (data && (data.code === -1003 || data.msg?.includes('rate limit')));
    }
    
    return error.message?.includes('rate limit') || 
           error.message?.includes('429');
  }
  
  /**
   * Перевірка чи можна повторити запит
   */
  isRetryableError(error) {
    if (error.response) {
      const status = error.response.status;
      // Повторюємо тільки серверні помилки та rate limits
      return status >= 500 || status === 429;
    }
    
    // Мережеві помилки
    return error.code === 'ECONNRESET' || 
           error.code === 'ENOTFOUND' || 
           error.code === 'ECONNABORTED';
  }
  
  /**
   * Налаштування таймерів для скидання лічильників
   */
  setupResetTimers() {
    // Скидання лічильника за хвилину
    setInterval(() => {
      this.requestsThisMinute = 0;
      this.currentWeight = 0;
      logger.debug('Minute counters reset');
    }, 60000);
    
    // Скидання лічильника за секунду
    setInterval(() => {
      this.requestsThisSecond = 0;
      logger.debug('Second counter reset');
    }, 1000);
  }
  
  /**
   * Оновлення статистики
   */
  updateStats(waitTime) {
    this.stats.totalRequests++;
    this.stats.averageWaitTime = (
      (this.stats.averageWaitTime * (this.stats.totalRequests - 1) + waitTime) / 
      this.stats.totalRequests
    );
    this.stats.maxWaitTime = Math.max(this.stats.maxWaitTime, waitTime);
  }
  
  /**
   * Отримання поточної статистики
   */
  getStats() {
    const uptime = Date.now() - this.stats.startTime;
    const requestsPerMinute = (this.stats.totalRequests / (uptime / 60000)).toFixed(2);
    
    return {
      ...this.stats,
      uptime,
      requestsPerMinute: parseFloat(requestsPerMinute),
      queueLength: this.requestQueue.length,
      currentWeight: this.currentWeight,
      backoffMultiplier: this.backoffMultiplier,
      requestsThisMinute: this.requestsThisMinute,
      requestsThisSecond: this.requestsThisSecond
    };
  }
  
  /**
   * Очищення черги та скидання стану
   */
  reset() {
    this.requestQueue = [];
    this.currentWeight = 0;
    this.requestsThisMinute = 0;
    this.requestsThisSecond = 0;
    this.backoffMultiplier = 1.0;
    this.lastRequestTime = 0;
    
    logger.info('Rate limit manager reset');
  }
  
  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('Shutting down rate limit manager...');
    
    // Чекаємо завершення поточних запитів
    while (this.isProcessing || this.requestQueue.length > 0) {
      await sleep(100);
    }
    
    logger.info('Rate limit manager shutdown complete');
  }
}

// Singleton instance для глобального використання
let globalRateLimitManager = null;

export function getRateLimitManager(options = {}) {
  if (!globalRateLimitManager) {
    globalRateLimitManager = new BinanceRateLimitManager(options);
  }
  return globalRateLimitManager;
}

export default BinanceRateLimitManager;