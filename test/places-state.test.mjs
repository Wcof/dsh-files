import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PLACES, placesKey, placeIdentity, resolvePlace, normalizePlaces, readPlaces, writePlaces, movePlace, dropPosition } from '../web/places-state.js';

const roots = [{ id: 'home', path: '/sandbox', label: 'Home' }, { id: 'documents', path: '/sandbox/Documents', label: 'Documents' }];
function memory() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('favorites initialize once and preserve custom order, aliases, removal and an empty list', () => {
  const storage = memory(), key = placesKey('darwin', '/sandbox');
  const original = readPlaces(storage, key, roots, 'darwin');
  assert.deepEqual(original, [{ root: 'home' }, { root: 'documents' }]);
  const changed = [{ path: '/sandbox/Design', label: 'Design work' }, { root: 'home', label: 'My files' }];
  assert.equal(writePlaces(storage, key, changed), true);
  assert.deepEqual(readPlaces(storage, key, roots, 'darwin'), changed);
  assert.deepEqual(resolvePlace(changed[1], roots), { path: '/sandbox', label: 'My files', icon: 'home' });
  assert.equal(resolvePlace({ root: 'documents' }, [{ ...roots[1], label: '文稿' }]).label, '文稿');
  writePlaces(storage, key, []);
  assert.deepEqual(readPlaces(storage, key, roots, 'darwin'), []);
});

test('favorites storage is isolated by host home and platform, and errors never claim persistence', () => {
  const storage = memory();
  writePlaces(storage, placesKey('darwin', '/sandbox'), []);
  assert.equal(readPlaces(storage, placesKey('darwin', '/other'), roots, 'darwin').length, 2);
  assert.equal(readPlaces(storage, placesKey('win32', '/sandbox'), roots, 'win32').length, 2);
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.equal(readPlaces(blocked, 'key', roots, 'darwin').length, 2);
  assert.equal(writePlaces(blocked, 'key', []), false);
  storage.setItem('key', '{invalid');
  assert.equal(readPlaces(storage, 'key', roots, 'darwin').length, 2);
});

test('untrusted favorites are bounded, normalized and deduplicated without granting access', () => {
  assert.deepEqual(normalizePlaces([
    null, {}, { path: 'relative', label: 'bad' }, { path: '/sandbox/\0bad', label: 'bad' },
    { root: 'missing' }, { root: 'home', label: ' My files ' }, { path: '/sandbox/', label: 'duplicate' },
    { path: '/outside', label: 'Bookmark only', content: 'never persist' },
  ], roots, 'darwin'), [{ root: 'home', label: 'My files' }, { path: '/outside', label: 'Bookmark only' }]);
  const windows = [{ id: 'home', path: 'C:\\Users\\Demo', label: 'Home' }];
  assert.equal(normalizePlaces([{ root: 'home' }, { path: 'c:/users/demo/', label: 'duplicate' }], windows, 'win32').length, 1);
  assert.equal(placeIdentity('\\\\HOST\\Share\\', 'win32'), placeIdentity('//host/share', 'win32'));
  assert.notEqual(placeIdentity('/A', 'darwin'), placeIdentity('/a', 'darwin'));
  assert.equal(normalizePlaces(Array.from({ length: 100 }, (_, i) => ({ path: `/folder-${i}`, label: 'folder' })), roots, 'darwin').length, MAX_PLACES);
});

test('drag gaps and keyboard moves reorder without duplicating, losing or mutating entries', () => {
  const items = ['a', 'b', 'c', 'd'];
  assert.deepEqual(movePlace(items, 0, dropPosition(0, 4, 4)), ['b', 'c', 'd', 'a']);
  assert.deepEqual(movePlace(items, 3, dropPosition(3, 0, 4)), ['d', 'a', 'b', 'c']);
  assert.deepEqual(movePlace(items, 1, dropPosition(1, 2, 4)), items);
  assert.deepEqual(movePlace(items, 1, 2), ['a', 'c', 'b', 'd']);
  assert.equal(movePlace(items, -1, 0), items); assert.equal(movePlace(items, 0, 4), items);
  assert.deepEqual(items, ['a', 'b', 'c', 'd']);
});
