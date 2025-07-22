import assert from 'assert';
import { getBinanceClient } from '../src/api/binanceClient.js';

export async function testHistoricalKlinesHandlesPagination() {
  const client = getBinanceClient();
  const original = client.getKlines.bind(client);
  const start = Date.now();
  const total = 2880; // 48 hours of 1m klines

  const klines = [];
  for (let i = 0; i < total; i++) {
    const open = start + i * 60_000;
    const close = open + 59_000;
    klines.push([open, '1', '1', '1', '1', '1', close, '1', '1', '1', '1']);
  }

  let callCount = 0;
  client.getKlines = async (symbol, interval, startTime, endTime, limit) => {
    callCount++;
    const res = [];
    for (const k of klines) {
      if (k[0] >= startTime && k[0] <= endTime) {
        res.push(k);
        if (res.length >= limit) break;
      }
    }
    return res;
  };

  const end = start + total * 60_000;
  const result = await client.getHistoricalKlines('TEST', '1m', start, end);

  assert.strictEqual(result.length, total);
  assert(callCount > 1);

  client.getKlines = original;
}
