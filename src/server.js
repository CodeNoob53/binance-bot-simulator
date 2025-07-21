import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDatabase } from './database/init.js';
import { symbolModel, listingAnalysisModel, historicalKlineModel } from './database/models.js';
import { calculateVolatility } from './utils/calculations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(join(__dirname, '../public')));

app.get('/api/symbols', async (req, res) => {
  try {
    const rows = await symbolModel.getSymbolsWithData();
    res.json(rows.map(r => r.symbol));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/klines', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
  try {
    const db = await getDatabase();
    const row = await symbolModel.findBySymbol(symbol);
    if (!row) return res.status(404).json({ error: 'Symbol not found' });

    const klines = await db.all(
      `SELECT open_time, open_price, high_price, low_price, close_price, volume
       FROM historical_klines
       WHERE symbol_id = ?
       ORDER BY open_time DESC
       LIMIT 100`,
      row.id
    );

    res.json(klines.reverse());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/info', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
  try {
    const db = await getDatabase();
    const row = await symbolModel.findBySymbol(symbol);
    if (!row) return res.status(404).json({ error: 'Symbol not found' });

    const listing = await listingAnalysisModel.findBySymbolId(row.id);
    const first = await historicalKlineModel.getFirstKline(row.id);
    const last = await db.get(
      `SELECT close_price FROM historical_klines WHERE symbol_id = ? ORDER BY open_time DESC LIMIT 1`,
      row.id
    );
    const last100 = await db.all(
      `SELECT close_price FROM historical_klines WHERE symbol_id = ? ORDER BY open_time DESC LIMIT 100`,
      row.id
    );

    const startPrice = first ? first.open_price : null;
    const lastPrice = last ? last.close_price : null;
    const changePercent = startPrice && lastPrice ? ((lastPrice - startPrice) / startPrice) * 100 : null;
    const volatility = last100.length > 1 ? calculateVolatility(last100.map(k => ({ close: k.close_price }))) : null;

    res.json({
      symbol: row.symbol,
      listing_date: listing ? listing.listing_date : null,
      start_price: startPrice,
      last_price: lastPrice,
      change_percent: changePercent,
      volatility
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
