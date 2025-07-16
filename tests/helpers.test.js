import assert from 'assert';
import { parseTimeframe, average } from '../src/utils/helpers.js';

export async function testParseTimeframe() {
  assert.strictEqual(parseTimeframe('1m'), 60 * 1000);
  assert.strictEqual(parseTimeframe('2h'), 2 * 60 * 60 * 1000);
}

export async function testAverage() {
  assert.strictEqual(average([1, 2, 3]), 2);
  assert.strictEqual(average([]), 0);
}
