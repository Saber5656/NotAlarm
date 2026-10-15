/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  currentPlanningZone,
  didPlanningZoneChange,
  loadPlanningZone,
  PLANNING_ZONE_KEY,
  savePlanningZone,
} from '../src/planningZone';
import type { KeyValueStore } from '../src/suppressionJournal';

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: async (key) => data[key] ?? null,
    setItem: async (key, value) => {
      data[key] = value;
    },
    removeItem: async (key) => {
      delete data[key];
    },
  };
}

test('the signature is the IANA zone of the device', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  try {
    assert.equal(currentPlanningZone(), 'Asia/Tokyo');
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(currentPlanningZone(), 'America/Los_Angeles');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('a first run has nothing to compare and is not a change', () => {
  assert.equal(didPlanningZoneChange(null, 'Asia/Tokyo'), false);
  assert.equal(didPlanningZoneChange('Asia/Tokyo', 'Asia/Tokyo'), false);
  assert.equal(didPlanningZoneChange('Asia/Tokyo', 'Europe/Paris'), true);
});

test('the zone round-trips and unreadable data reads as unknown, not as a change', async () => {
  const store = memoryStore();
  assert.equal(await loadPlanningZone(store), null);
  await savePlanningZone(store, 'Asia/Tokyo');
  assert.equal(await loadPlanningZone(store), 'Asia/Tokyo');
  const broken = memoryStore({ [PLANNING_ZONE_KEY]: '{oops' });
  assert.equal(await loadPlanningZone(broken), null);
});
