import { BaseStrategy } from './baseStrategy.js';
import logger from '../../utils/logger.js';
import { calculateLiquidity, calculateVolatility } from '../../utils/calculations.js';

export class NewListingScalperStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.name = 'NewListingScalper';
    this.cooldowns = new Map();
    this.liquidityThreshold = config.minLiquidityUsdt || 10000;
    this.volatilityThreshold = config.minVolatilityPercent || 2.0;
    this.maxPriceImpact = config.maxPriceImpact || 0.5;
    this.orderBookDepth = config.orderBookDepth || 10;
  }

  /**
   * Перевірка умов входу для нового лістингу
   */
  async checkEntryConditions(marketData, priceData) {
    const { symbol, ticker, orderBook, klines } = marketData;
    
    // 1. Перевірка що це новий лістинг
    if (!this.isNewListing(marketData)) {
      return { shouldEnter: false, reason: 'not_new_listing' };
    }

    // 2. Перевірка cooldown
    if (this.isOnCooldown(symbol)) {
      return { shouldEnter: false, reason: 'cooldown_active' };
    }

    // 3. Перевірка ліміту відкритих позицій
    if (this.activeTrades.size >= this.config.maxOpenTrades) {
      return { shouldEnter: false, reason: 'max_trades_reached' };
    }

    // 4. Перевірка ліквідності
    const liquidity = calculateLiquidity(orderBook, this.config.buyAmountUsdt);
    if (liquidity.totalLiquidity < this.liquidityThreshold) {
      return { 
        shouldEnter: false, 
        reason: 'insufficient_liquidity', 
        liquidity: liquidity.totalLiquidity 
      };
    }

    // 5. Перевірка price impact
    if (liquidity.priceImpact > this.maxPriceImpact) {
      return { 
        shouldEnter: false, 
        reason: 'high_price_impact', 
        priceImpact: liquidity.priceImpact 
      };
    }

    // 6. Перевірка волатильності
    const volatility = calculateVolatility(klines);
    if (volatility < this.volatilityThreshold) {
      return { 
        shouldEnter: false, 
        reason: 'low_volatility', 
        volatility 
      };
    }

    // 7. Перевірка технічних індикаторів
    const technicalSignal = this.analyzeTechnicalIndicators(klines, ticker);
    if (!technicalSignal.bullish) {
      return { 
        shouldEnter: false, 
        reason: 'bearish_signal', 
        signal: technicalSignal 
      };
    }

    // 8. Перевірка моментуму
    const momentum = this.analyzeMomentum(klines, ticker);
    if (!momentum.positive) {
      return { 
        shouldEnter: false, 
        reason: 'negative_momentum', 
        momentum 
      };
    }

    return { 
      shouldEnter: true, 
      reason: 'all_conditions_met',
      metrics: {
        liquidity: liquidity.totalLiquidity,
        priceImpact: liquidity.priceImpact,
        volatility,
        technicalSignal,
        momentum
      }
    };
  }

  /**
   * Перевірка чи це новий лістинг
   */
  isNewListing(marketData) {
    const { listingDate, currentTime } = marketData;
    const timeSinceListing = currentTime - listingDate;
    
    // Новий лістинг якщо пройшло менше 10 хвилин
    return timeSinceListing < (10 * 60 * 1000);
  }

  /**
   * Перевірка cooldown
   */
  isOnCooldown(symbol) {
    const cooldownEnd = this.cooldowns.get(symbol);
    if (!cooldownEnd) return false;
    
    const now = Date.now();
    if (now < cooldownEnd) {
      return true;
    }
    
    this.cooldowns.delete(symbol);
    return false;
  }

  /**
   * Встановлення cooldown
   */
  setCooldown(symbol, seconds = null) {
    const cooldownSeconds = seconds || this.config.cooldownSeconds || 300;
    const cooldownEnd = Date.now() + (cooldownSeconds * 1000);
    this.cooldowns.set(symbol, cooldownEnd);
  }

  /**
   * Аналіз технічних індикаторів
   */
  analyzeTechnicalIndicators(klines, ticker) {
    if (!klines || klines.length < 5) {
      return { bullish: false, reason: 'insufficient_data' };
    }

    const prices = klines.map(k => parseFloat(k.close));
    const volumes = klines.map(k => parseFloat(k.volume));
    const currentPrice = parseFloat(ticker.price);

    // RSI
    const rsi = this.calculateRSI(prices);
    const rsiSignal = rsi > 30 && rsi < 70; // Не перекуплено/перепродано

    // EMA
    const ema5 = this.calculateEMA(prices, 5);
    const emaSignal = currentPrice > ema5;

    // Volume
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const currentVolume = volumes[volumes.length - 1];
    const volumeSignal = currentVolume > avgVolume * 1.5;

    // Price action
    const priceAction = this.analyzePriceAction(klines);

    const bullish = rsiSignal && emaSignal && volumeSignal && priceAction.bullish;

    return {
      bullish,
      rsi,
      rsiSignal,
      emaSignal,
      volumeSignal,
      priceAction,
      confidence: this.calculateConfidence([rsiSignal, emaSignal, volumeSignal, priceAction.bullish])
    };
  }

  /**
   * Аналіз моментуму
   */
  analyzeMomentum(klines, ticker) {
    if (!klines || klines.length < 3) {
      return { positive: false, reason: 'insufficient_data' };
    }

    const prices = klines.map(k => parseFloat(k.close));
    const currentPrice = parseFloat(ticker.price);

    // Momentum indicators
    const priceChange = ((currentPrice - prices[0]) / prices[0]) * 100;
    const recentChange = ((prices[prices.length - 1] - prices[prices.length - 2]) / prices[prices.length - 2]) * 100;

    // MACD
    const macd = this.calculateMACD(prices);
    const macdSignal = macd && macd.histogram > 0;

    // Volume momentum
    const volumes = klines.map(k => parseFloat(k.volume));
    const volumeMomentum = volumes[volumes.length - 1] > volumes[volumes.length - 2];

    const positive = priceChange > 0 && recentChange > 0 && macdSignal && volumeMomentum;

    return {
      positive,
      priceChange,
      recentChange,
      macdSignal,
      volumeMomentum,
      strength: Math.abs(priceChange) + Math.abs(recentChange)
    };
  }

  /**
   * Аналіз price action
   */
  analyzePriceAction(klines) {
    const lastCandle = klines[klines.length - 1];
    const prevCandle = klines[klines.length - 2];

    const open = parseFloat(lastCandle.open);
    const high = parseFloat(lastCandle.high);
    const low = parseFloat(lastCandle.low);
    const close = parseFloat(lastCandle.close);

    // Тип свічки
    const isBullish = close > open;
    const bodySize = Math.abs(close - open);
    const shadowSize = (high - Math.max(open, close)) + (Math.min(open, close) - low);
    const bodyRatio = bodySize / (bodySize + shadowSize);

    // Паттерни
    const isDoji = bodySize < (high - low) * 0.1;
    const isHammer = !isDoji && bodyRatio > 0.6 && (Math.min(open, close) - low) > bodySize * 2;
    const isEngulfing = isBullish && prevCandle && close > parseFloat(prevCandle.open) && open < parseFloat(prevCandle.close);

    return {
      bullish: isBullish && (bodyRatio > 0.5 || isHammer || isEngulfing),
      isBullish,
      bodyRatio,
      isDoji,
      isHammer,
      isEngulfing,
      strength: bodyRatio * (isBullish ? 1 : -1)
    };
  }

  /**
   * Розрахунок RSI
   */
  calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return 50;

    const gains = [];
    const losses = [];

    for (let i = 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? -change : 0);
    }

    const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
    const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Розрахунок EMA
   */
  calculateEMA(prices, period) {
    if (prices.length < period) return prices[prices.length - 1];

    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * Розрахунок MACD
   */
  calculateMACD(prices) {
    if (prices.length < 26) return null;

    const ema12 = this.calculateEMA(prices, 12);
    const ema26 = this.calculateEMA(prices, 26);
    const macdLine = ema12 - ema26;

    // Простий сигнал - якщо MACD > 0
    return {
      macdLine,
      signal: macdLine > 0,
      histogram: macdLine // Спрощено
    };
  }

  /**
   * Розрахунок рівня впевненості
   */
  calculateConfidence(signals) {
    const trueCount = signals.filter(s => s).length;
    return (trueCount / signals.length) * 100;
  }

  /**
   * Виконання покупки
   */
  async executeBuy(marketData) {
    const { symbol, ticker, orderBook } = marketData;
    const currentPrice = parseFloat(ticker.price);
    const quantity = this.config.buyAmountUsdt / currentPrice;

    try {
      // Імітуємо покупку для симуляції
      const trade = {
        symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity,
        price: currentPrice,
        timestamp: Date.now(),
        commission: this.config.buyAmountUsdt * (this.config.binanceFeePercent / 100)
      };

      // Встановлюємо cooldown
      this.setCooldown(symbol);

      logger.info(`NewListingScalper: BUY ${symbol} at ${currentPrice} USDT`);

      return {
        success: true,
        trade,
        entryPrice: currentPrice,
        quantity,
        commission: trade.commission
      };

    } catch (error) {
      logger.error(`NewListingScalper: Error executing buy for ${symbol}: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Отримання умов виходу
   */
  getExitConditions(entryPrice, config) {
    const takeProfitPrice = entryPrice * (1 + config.takeProfitPercent / 100);
    const stopLossPrice = entryPrice * (1 - config.stopLossPercent / 100);
    const trailingStopActivationPrice = entryPrice * (1 + config.trailingStopActivationPercent / 100);

    return {
      takeProfitPrice,
      stopLossPrice,
      trailingStopActivationPrice,
      trailingStopEnabled: config.trailingStopEnabled,
      trailingStopPercent: config.trailingStopPercent
    };
  }

  /**
   * Скидання стану стратегії
   */
  reset() {
    this.cooldowns.clear();
    this.activeTrades.clear();
  }

  /**
   * Отримання статистики стратегії
   */
  getStats() {
    return {
      name: this.name,
      activeTrades: this.activeTrades.size,
      cooldowns: this.cooldowns.size,
      liquidityThreshold: this.liquidityThreshold,
      volatilityThreshold: this.volatilityThreshold
    };
  }
}

export default NewListingScalperStrategy;