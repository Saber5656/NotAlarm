/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import { createOrphanStore } from '../src/orphanedNotifications';

function memoryStore(initial?: string) {
  let value: string | null = initial ?? null;
  return {
    async getItem() {
      return value;
    },
    async setItem(_key: string, next: string) {
      value = next;
    },
    async removeItem() {
      value = null;
    },
    raw: () => value,
  };
}

test('ids are added once, listed and removed', async () => {
  const store = createOrphanStore(memoryStore());
  await store.add(['a', 'b']);
  await store.add(['b', 'c']);
  assert.deepEqual((await store.load()).sort(), ['a', 'b', 'c']);
  await store.remove(['b']);
  assert.deepEqual((await store.load()).sort(), ['a', 'c']);
});

function failingStore(failGet: boolean) {
  const writes: string[] = [];
  return {
    writes,
    async getItem(): Promise<string | null> {
      if (failGet) throw new Error('read failed');
      return null;
    },
    async setItem(_key: string, next: string) {
      writes.push(next);
    },
    async removeItem() {},
  };
}

test('a missing journal is the only thing that reads as empty', async () => {
  assert.deepEqual(await createOrphanStore(memoryStore()).load(), []);
});

test('a read exception rejects, and a mutation writes nothing', async () => {
  const backing = failingStore(true);
  const store = createOrphanStore(backing);
  await assert.rejects(() => store.load());
  await assert.rejects(() => store.add(['a']));
  await assert.rejects(() => store.remove(['a']));
  assert.deepEqual(backing.writes, []);
});

test('corrupt, wrong-version or malformed values reject and are never overwritten', async () => {
  const bad = [
    'not json',
    'null',
    '[1,2]',
    '{"version":1,"ids":"x"}',
    '{"version":1,"ids":[1,"ok"]}',
    '{"version":1,"ids":["ok",""]}',
    '{"version":2,"ids":["future-id"]}',
    '{"ids":["no-version"]}',
    '',
  ];
  for (const raw of bad) {
    const backing = memoryStore(raw);
    const store = createOrphanStore(backing);
    await assert.rejects(() => store.load(), Error, `load ${JSON.stringify(raw)}`);
    await assert.rejects(() => store.add(['new']), Error, `add ${JSON.stringify(raw)}`);
    await assert.rejects(() => store.remove(['x']), Error, `remove ${JSON.stringify(raw)}`);
    assert.equal(backing.raw(), raw, `journal kept for ${JSON.stringify(raw)}`);
  }
});

test('a version-2 journal keeps its unknown ids after a failed mutation', async () => {
  const raw = '{"version":2,"ids":["future-id"],"extra":true}';
  const backing = memoryStore(raw);
  await assert.rejects(() => createOrphanStore(backing).add(['x']));
  assert.equal(backing.raw(), raw);
});

test('a rejected mutation does not poison the following operations', async () => {
  const backing = memoryStore('not json');
  const store = createOrphanStore(backing);
  await assert.rejects(() => store.add(['a']));
  await backing.setItem('k', '{"version":1,"ids":["kept"]}');
  await store.add(['b']);
  assert.deepEqual((await store.load()).sort(), ['b', 'kept']);
});

test('concurrent adds are not lost', async () => {
  const store = createOrphanStore(memoryStore());
  await Promise.all([store.add(['a']), store.add(['b']), store.remove(['z']), store.add(['c'])]);
  assert.deepEqual((await store.load()).sort(), ['a', 'b', 'c']);
});
