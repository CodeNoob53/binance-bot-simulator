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

export async function testTrailingActivationBelowTP() {
  process.env.DB_PATH = ':memory:';
  await getDatabase();
  const generator = new ConfigurationGenerator();
  const configs = await generator.generateConfigurations();
  for (const cfg of configs) {
    if (cfg.trailingStopEnabled) {
      assert(cfg.trailingStopActivationPercent < cfg.takeProfitPercent);
    }
  }
  await closeDatabase();
}
