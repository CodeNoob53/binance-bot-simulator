import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDatabase } from './database/init.js';
import { symbolModel, listingAnalysisModel, historicalKlineModel } from './database/models.js';
import { TradingSimulator } from './simulation/simulator.js';
import { calculateVolatility } from './utils/calculations.js';
import logger from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  next();
});

// API Routes
app.get('/api/symbols', async (req, res) => {
  try {
    logger.info('Fetching symbols with data');
    const rows = await symbolModel.getSymbolsWithData();
    const symbols = rows.map(r => r.symbol).sort();
    logger.info(`Found ${symbols.length} symbols with historical data`);
    res.json(symbols);
  } catch (err) {
    logger.error('Error fetching symbols:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/klines', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'Missing symbol parameter' });
  }
  
  try {
    logger.info(`Fetching klines for ${symbol}`);
    const db = await getDatabase();
    const row = await symbolModel.findBySymbol(symbol);
    
    if (!row) {
      logger.warn(`Symbol ${symbol} not found in database`);
      return res.status(404).json({ error: 'Symbol not found' });
    }

    // Отримуємо останні 200 свічок для кращого відображення
    const klines = await db.all(
      `SELECT open_time, open_price, high_price, low_price, close_price, volume
       FROM historical_klines
       WHERE symbol_id = ?
       ORDER BY open_time DESC
       LIMIT 200`,
      row.id
    );

    const formattedKlines = klines.reverse().map(k => ({
      open_time: k.open_time,
      open_price: parseFloat(k.open_price),
      high_price: parseFloat(k.high_price),
      low_price: parseFloat(k.low_price),
      close_price: parseFloat(k.close_price),
      volume: parseFloat(k.volume)
    }));

    logger.info(`Returning ${formattedKlines.length} klines for ${symbol}`);
    res.json(formattedKlines);
  } catch (err) {
    logger.error(`Error fetching klines for ${symbol}:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/info', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'Missing symbol parameter' });
  }
  
  try {
    logger.info(`Fetching info for ${symbol}`);
    const db = await getDatabase();
    const row = await symbolModel.findBySymbol(symbol);
    
    if (!row) {
      logger.warn(`Symbol ${symbol} not found in database`);
      return res.status(404).json({ error: 'Symbol not found' });
    }

    const listing = await listingAnalysisModel.findBySymbolId(row.id);
    const first = await historicalKlineModel.getFirstKline(row.id);
    
    const last = await db.get(
      `SELECT close_price FROM historical_klines WHERE symbol_id = ? ORDER BY open_time DESC LIMIT 1`,
      row.id
    );
    
    // Отримуємо більше даних для кращого розрахунку волатільності
    const last100 = await db.all(
      `SELECT close_price FROM historical_klines WHERE symbol_id = ? ORDER BY open_time DESC LIMIT 200`,
      row.id
    );

    const startPrice = first ? first.open_price : null;
    const lastPrice = last ? last.close_price : null;
    const changePercent = startPrice && lastPrice ? ((lastPrice - startPrice) / startPrice) * 100 : null;
    const volatility = last100.length > 10 ? calculateVolatility(last100.map(k => ({ close: k.close_price }))) : null;

    // Додаткова статистика
    const klineCount = await historicalKlineModel.getKlineCount(row.id);
    const dateRange = first && last ? {
      start: new Date(first.open_time).toISOString(),
      end: new Date(last.close_time || Date.now()).toISOString()
    } : null;

    const info = {
      symbol: row.symbol,
      listing_date: listing ? listing.listing_date : null,
      start_price: startPrice,
      last_price: lastPrice,
      change_percent: changePercent,
      volatility,
      kline_count: klineCount,
      date_range: dateRange,
      base_asset: row.base_asset,
      quote_asset: row.quote_asset,
      status: row.status
    };

    logger.info(`Returning info for ${symbol}: ${klineCount} klines, volatility: ${volatility?.toFixed(2)}%`);
    res.json(info);
  } catch (err) {
    logger.error(`Error fetching info for ${symbol}:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Новий API endpoint для симуляції
app.post('/api/simulate', async (req, res) => {
  const { symbol, parameters } = req.body;

  if (!symbol || !parameters) {
    return res.status(400).json({ error: 'Missing symbol or parameters' });
  }

  try {
    logger.info(`Starting simulation for ${symbol} with parameters:`, parameters);

    const symbolRow = await symbolModel.findBySymbol(symbol);
    if (!symbolRow) {
      return res.status(404).json({ error: 'Symbol not found' });
    }

    const listing = await listingAnalysisModel.findBySymbolId(symbolRow.id);
    if (!listing) {
      return res.status(404).json({ error: 'Listing info not found' });
    }

    const start = listing.listing_date;
    const end = start + 60 * 60 * 1000;
    const klines = await historicalKlineModel.getBySymbolAndTimeRange(
      symbolRow.id,
      start,
      end
    );

    if (!klines || klines.length < 3) {
      return res.status(404).json({ error: 'Not enough market data' });
    }

    const simulator = new TradingSimulator(parameters);
    const configId = await simulator.saveConfiguration();

    const listingInfo = {
      symbol_id: symbolRow.id,
      symbol: symbolRow.symbol,
      listing_date: listing.listing_date,
      klines_count: klines.length
    };

    await simulator.processListing(listingInfo, configId);
    await simulator.closeAllActiveTrades('api_request', configId);
    const results = await simulator.generateResults(configId);

    logger.info(`Simulation completed for ${symbol}`);
    res.json(results.summary);

  } catch (err) {
    logger.error(`Error running simulation for ${symbol}:`, err);
    res.status(500).json({ error: 'Simulation failed', details: err.message });
  }
});

// Статистика системи
app.get('/api/stats', async (req, res) => {
  try {
    const db = await getDatabase();
    
    const stats = {
      total_symbols: (await db.get('SELECT COUNT(*) as count FROM symbols')).count,
      symbols_with_data: (await db.get(`
        SELECT COUNT(DISTINCT symbol_id) as count 
        FROM historical_klines
      `)).count,
      total_klines: (await db.get('SELECT COUNT(*) as count FROM historical_klines')).count,
      analyzed_listings: (await db.get(`
        SELECT COUNT(*) as count 
        FROM listing_analysis 
        WHERE data_status = 'analyzed'
      `)).count,
      date_range: await db.get(`
        SELECT 
          MIN(datetime(open_time/1000, 'unixepoch')) as earliest,
          MAX(datetime(close_time/1000, 'unixepoch')) as latest
        FROM historical_klines
      `)
    };
    
    res.json(stats);
  } catch (err) {
    logger.error('Error fetching system stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(port, () => {
  logger.info(`🚀 Binance Bot Simulator server started on port ${port}`);
  logger.info(`📊 Web interface: http://localhost:${port}`);
  logger.info(`🔗 API endpoints: http://localhost:${port}/api/`);
});
