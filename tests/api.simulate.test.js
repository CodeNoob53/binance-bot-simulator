import assert from 'assert';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { getDatabase, closeDatabase } from '../src/database/init.js';
import { SymbolModel, ListingAnalysisModel, HistoricalKlineModel } from '../src/database/models.js';

export async function testSimulateApiReturnsDeterministicValues() {
  const PORT = 3055;
  const DB_FILE = '/tmp/simulate-api.sqlite';
  await closeDatabase().catch(() => {});
  await fs.unlink(DB_FILE).catch(() => {});
  process.env.DB_PATH = DB_FILE;
  process.env.PORT = PORT;

  const db = await getDatabase();
  const symbolModel = new SymbolModel();
  const listingModel = new ListingAnalysisModel();
  const klineModel = new HistoricalKlineModel();

  const symbolId = await symbolModel.create({
    symbol: 'TSTUSDT',
    baseAsset: 'TST',
    quoteAsset: 'USDT'
  });

  await listingModel.create({ symbolId, listingDate: 0 });

  const klines = [];
  for (let i = 0; i < 20; i++) {
    klines.push([
      symbolId,
      i * 60000,
      i * 60000 + 59000,
      10,
      i === 1 ? 12 : 10,
      9.5,
      10,
      100,
      100,
      1,
      50,
      50
    ]);
  }
  await klineModel.createBatch(klines);

  const server = spawn('node', ['src/server.js'], {
    env: { ...process.env, PORT, DB_PATH: DB_FILE }
  });

  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/health`);
      if (r.ok) break;
    } catch (err) {
      // retry until server is ready
    }
    await new Promise(r => setTimeout(r, 100));
  }

  const res = await fetch(`http://localhost:${PORT}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: 'TSTUSDT',
      parameters: {
        name: 'TestCfg',
        takeProfitPercent: 0.1,
        stopLossPercent: 0.05,
        buyAmountUsdt: 100,
        maxOpenTrades: 1,
        trailingStopEnabled: false,
        binanceFeePercent: 0.00075
      }
    })
  });

  const data = await res.json();
  assert.strictEqual(data.totalTrades, 1);
  assert.strictEqual(data.profitableTrades, 1);
  assert.strictEqual(Number(data.totalReturn.toFixed(4)), 9.8425);
  assert.strictEqual(Number(data.finalBalance.toFixed(4)), 10009.8425);

  server.kill();
  await closeDatabase();
  await fs.unlink(DB_FILE).catch(() => {});
}
