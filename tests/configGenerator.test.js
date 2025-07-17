import assert from 'assert';
import { getDatabase, closeDatabase } from '../src/database/init.js';
import { ConfigurationGenerator } from '../src/simulation/configGenerator.js';

export async function testGetConfigurationsCamelCase() {
  process.env.DB_PATH = ':memory:';
  await getDatabase();
  const generator = new ConfigurationGenerator();
  await generator.generateConfigurations();
  const configs = await generator.getConfigurations();
  assert(configs.length > 0);
  const cfg = configs[0];
  assert.strictEqual(typeof cfg.takeProfitPercent, 'number');
  assert.strictEqual(typeof cfg.stopLossPercent, 'number');
  assert.strictEqual(typeof cfg.buyAmountUsdt, 'number');
  assert.strictEqual(typeof cfg.maxOpenTrades, 'number');
  await closeDatabase();
}
