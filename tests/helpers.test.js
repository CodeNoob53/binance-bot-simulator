import { strict as assert } from 'assert';
import { parseTimeframe, average } from '../src/utils/helpers.js';

describe('helpers', function () {
  it('parses timeframe strings', function () {
    assert.strictEqual(parseTimeframe('1m'), 60 * 1000);
    assert.strictEqual(parseTimeframe('2h'), 2 * 60 * 60 * 1000);
  });

  it('computes average of numbers', function () {
    assert.strictEqual(average([1, 2, 3]), 2);
    assert.strictEqual(average([]), 0);
  });
});
