import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDatabase } from './database/init.js';
import { symbolModel } from './database/models.js';

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

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
