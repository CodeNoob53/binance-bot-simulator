import { getBinanceClient } from '../api/binanceClient.js';
import { getDatabase } from '../database/init.js';
import logger from '../utils/logger.js';

export class SymbolCollector {
  constructor() {
    this.binanceClient = getBinanceClient();
    this.dbPromise = getDatabase();
  }
  
  async collectAllUSDTSymbols() {
    try {
      logger.info('Fetching exchange info from Binance...');
      const exchangeInfo = await this.binanceClient.getExchangeInfo();
      
      const usdtSymbols = exchangeInfo.symbols
        .filter(s => 
          s.status === 'TRADING' && 
          s.quoteAsset === 'USDT' &&
          s.isSpotTradingAllowed === true
        )
        .map(s => ({
          symbol: s.symbol,
          baseAsset: s.baseAsset,
          quoteAsset: s.quoteAsset,
          status: 'active'
        }));
      
      logger.info(`Found ${usdtSymbols.length} active USDT trading pairs`);
      
      // Зберігаємо в БД
      const db = await this.dbPromise;
      await db.exec('BEGIN');
      try {
        for (const [index, symbolData] of usdtSymbols.entries()) {
          logger.info(`Processing symbol ${index + 1}/${usdtSymbols.length}: ${symbolData.symbol}`);
          await db.run(
            `INSERT OR REPLACE INTO symbols (symbol, base_asset, quote_asset, status, updated_at) VALUES (?, ?, ?, ?, ?)`,
            symbolData.symbol,
            symbolData.baseAsset,
            symbolData.quoteAsset,
            symbolData.status,
            Date.now()
          );
          logger.info(`Finished processing ${symbolData.symbol}`);
        }
        await db.exec('COMMIT');
      } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
      }
      
      logger.info(`Saved ${usdtSymbols.length} symbols to database`);
      return usdtSymbols.length;
      
    } catch (error) {
      logger.error('Failed to collect symbols:', error);
      throw error;
    }
  }
  
  async getSymbolsForAnalysis(limit = null) {
    let query = `
      SELECT s.*
      FROM symbols s
      LEFT JOIN listing_analysis la ON s.id = la.symbol_id
      WHERE s.status = 'active'
      AND s.quote_asset = 'USDT'
      AND (la.id IS NULL OR la.data_status = 'error')
    `;

    if (limit) {
      query += ` LIMIT ${limit}`;
    }
    const db = await this.dbPromise;
    return db.all(query);
  }
}
