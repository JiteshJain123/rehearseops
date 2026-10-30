import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLogLines, summarizeLogSignals, isValidEvidenceReference } from '../src/normalize.js';
import { extractJsonObject, getProviderConfig, pickModelForTier } from '../src/provider.js';
import { getScenario } from '../src/fixtures.js';

test('parses timestamps, severities and services without executing log content', () => {
  const events = parseLogLines('[2026-10-28T14:00:00Z] ERROR service=payments db timeout\n[14:00:02] WARN api slow');
  assert.equal(events.length, 2);
  assert.equal(events[0].level, 'error');
  assert.equal(events[0].service, 'payments');
  assert.equal(events[1].level, 'warning');
  assert.equal(events[0].id, 'U001');
});

test('summarizes event severities', () => {
  const events = parseLogLines('[12:00:00] ERROR service=x failed\n[12:00:01] WARN service=y slow\n[12:00:02] INFO service=z ok');
  assert.deepEqual(summarizeLogSignals(events), { eventCount: 3, error: 1, warning: 1, info: 1, critical: 0 });
});

test('checks evidence references against source IDs', () => {
  const scenario = getScenario('database-pool-exhaustion');
  assert.equal(isValidEvidenceReference('E001', scenario.events), true);
  assert.equal(isValidEvidenceReference('E999', scenario.events), false);
});

test('extracts JSON from plain, fenced, prose-wrapped and <think>-prefixed output', () => {
  assert.deepEqual(extractJsonObject('{"summary":"ok"}'), { summary: 'ok' });
  assert.deepEqual(extractJsonObject('```json\n{"summary":"ok"}\n```'), { summary: 'ok' });
  assert.deepEqual(extractJsonObject('Here is the result: {"summary":"ok"} hope that helps {x}'), { summary: 'ok' });
  assert.deepEqual(extractJsonObject('<think>maybe {"summary":"wrong"}</think>\n{"summary":"ok"}'), { summary: 'ok' });
  assert.throws(() => extractJsonObject('no json here'));
});

test('provider defaults use the Token Factory endpoint and two Nemotron tiers', () => {
  const config = getProviderConfig({});
  assert.equal(config.baseUrl, 'https://api.tokenfactory.nebius.com/v1');
  assert.match(config.models.reasoning, /^nvidia\/Nemotron-3-Ultra/);
  assert.match(config.models.fast, /Nano/);
  assert.equal(getProviderConfig({ NEBIUS_MODEL: 'nvidia/x' }).models.fast, 'nvidia/x');
  assert.equal(getProviderConfig({ NEBIUS_MODEL: 'nvidia/x', NEBIUS_FAST_MODEL: 'nvidia/y' }).models.fast, 'nvidia/y');
});

test('model discovery picks a tier-appropriate Nemotron model and skips VL/guard models', () => {
  const catalog = ['meta/llama', 'nvidia/Nemotron-3.5-Super-VL', 'nvidia/Nemotron-3-Ultra-550b-a55b', 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', 'nvidia/Nemotron-3_5-Lightning'];
  assert.equal(pickModelForTier('reasoning', catalog), 'nvidia/Nemotron-3-Ultra-550b-a55b');
  assert.equal(pickModelForTier('fast', catalog), 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
  assert.equal(pickModelForTier('fast', ['meta/llama']), null);
});
