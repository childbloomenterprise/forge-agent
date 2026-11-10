import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, isTransient, retryDelayMs } from '../src/trueforge/runner';

test('classifies errors', () => {
  assert.equal(isTransient('[Model Error] Request failed (429): You exceeded your current quota'), true);
  assert.equal(isTransient('[Model Error] Cannot connect to API: Headers Timeout Error'), true);
  assert.equal(isTransient('Request failed (503): overloaded'), true);
  assert.equal(isTransient('Request failed (401): invalid api key'), false);
  assert.equal(isTransient('API key not valid. Please pass a valid API key.'), false);
});

test('retry delay honours provider hint and caps', () => {
  assert.equal(retryDelayMs('Please retry in 12.3s.', 1), 12800);
  assert.equal(retryDelayMs('"retryDelay": "7s"', 1), 7500);
  assert.equal(retryDelayMs('Please retry in 300s', 1), 60000);
  assert.equal(retryDelayMs('Request failed (429): You exceeded your current quota', 1), 15000);
  assert.equal(retryDelayMs('Request failed (429): You exceeded your current quota', 2), 30000);
  assert.equal(retryDelayMs('503', 1), 2000);
  assert.equal(retryDelayMs('503', 2), 4000);
});

test('error kinds drive retry/fallback', () => {
  assert.equal(classifyError('[Model Error] Cannot connect to API: bad port'), 'unreachable');
  assert.equal(classifyError('Request failed (413): Request too large for model'), 'too_large');
  assert.equal(classifyError('Request failed (429): Rate limit reached'), 'rate_limit');
  assert.equal(classifyError('Request failed (400): API key not valid'), 'auth');
  assert.equal(classifyError('Request failed (503)'), 'server');
});
