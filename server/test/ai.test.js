import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAiError } from '../src/ai.js';

const apiError = (status, message) => Object.assign(new Error(`${status} {"type":"error"}`), { status, error: { type: 'error', error: { message } } });

test('out-of-credits error becomes a readable 402 without raw JSON', () => {
  const e = toAiError(apiError(400, 'Your credit balance is too low to access the Anthropic API.'));
  assert.equal(e.status, 402);
  assert.equal(e.code, 'ai_no_credits');
  assert.match(e.message, /out of credits/);
  assert.doesNotMatch(e.message, /[{}]/);
});

test('other Anthropic failures map to clear statuses', () => {
  assert.equal(toAiError(apiError(401, 'invalid x-api-key')).code, 'ai_auth');
  assert.equal(toAiError(apiError(429, 'slow down')).status, 429);
  const other = toAiError(apiError(400, 'bad model'));
  assert.equal(other.status, 502);
  assert.match(other.message, /bad model/);
  assert.equal(toAiError(new Error('socket hang up')).code, 'ai_failed');
});
