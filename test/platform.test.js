'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pollOffsetFor } = require('../src/platform');

test('spreads thermostat polls evenly across the polling interval', () => {
  const offsets = Array.from(
    { length: 5 },
    (_, index) => pollOffsetFor(index, 5, 30000),
  );

  assert.deepEqual(offsets, [0, 6000, 12000, 18000, 24000]);
});
