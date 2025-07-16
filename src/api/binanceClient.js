import axios from 'axios';
import logger from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

class BinanceClient {
  constructor() {
    this.baseURL = process.env.BINANCE_API_BASE_URL || 'https://api.binance.com';
    this.rateLimitDelay = parseInt(process.env.RATE_LIMIT_DELAY_MS) || 100;
    this.retryAttempts = parseInt(process.env.RETRY_ATTEMPTS) || 3;
    
    this.axios = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
  
  async request(endpoint, params = {}) {
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        await sleep(this.rateLimitDelay);
        
        const response = await this.axios.get(endpoint, { params });
        return response.data;
        
      } catch (error) {
        const errorMessage = error.response?.data?.msg || error.message;
        logger.warn(`API request failed (attempt ${attempt}/${this.retryAttempts}): ${errorMessage}`);
        
        if (attempt === this.retryAttempts) {
          throw new Error(`API request failed after ${this.retryAttempts} attempts: ${errorMessage}`);
        }
        
        // Exponential backoff
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  
  async getExchangeInfo() {
    logger.debug('Fetching exchange info...');
    return await this.request('/api/v3/exchangeInfo');
  }
  
  async getKlines(symbol, interval, startTime, endTime, limit = 1000) {
    logger.debug(`Fetching klines for ${symbol} [${interval}]...`);
    
    const params = {
      symbol,
      interval,
      limit
    };
    
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;
    
    return await this.request('/api/v3/klines', params);
  }
  
  async getHistoricalKlines(symbol, interval, startTime, endTime) {
    const allKlines = [];
    let currentStartTime = startTime;
    const MAX_KLINES = 1000;
    
    while (currentStartTime < endTime) {
      try {
        const klines = await this.getKlines(symbol, interval, currentStartTime, endTime, MAX_KLINES);
        
        if (!klines || klines.length === 0) break;
        
        // Уникаємо дублювання
        const klinesToAdd = klines.length === MAX_KLINES ? klines.slice(0, -1) : klines;
        allKlines.push(...klinesToAdd);
        
        // Наступний batch
        currentStartTime = klines[klines.length - 1][6] + 1; // closeTime + 1ms
        
        logger.debug(`Collected ${allKlines.length} klines for ${symbol}`);
        
      } catch (error) {
        logger.error(`Error fetching historical klines for ${symbol}:`, error.message);
        break;
      }
    }
    
    return allKlines;
  }
  
  async getSymbolPriceTicker(symbol = null) {
    const endpoint = '/api/v3/ticker/price';
    const params = symbol ? { symbol } : {};
    return await this.request(endpoint, params);
  }
  
  async get24hrTicker(symbol = null) {
    const endpoint = '/api/v3/ticker/24hr';
    const params = symbol ? { symbol } : {};
    return await this.request(endpoint, params);
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