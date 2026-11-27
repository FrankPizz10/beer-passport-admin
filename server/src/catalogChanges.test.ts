import { checkArchiveDependencies, fingerprint, isRoutine, parseChanges } from './catalogChanges';

it('classifies only descriptions and contact changes as routine', () => {
  expect(isRoutine('beers', 'edit', { descript: 'Updated description' })).toBe(true);
  expect(isRoutine('beers', 'edit', { name: 'Renamed' })).toBe(false);
  expect(isRoutine('beers', 'archive', {})).toBe(false);
  expect(isRoutine('breweries', 'edit', { website: 'https://example.com', name: 'New name' })).toBe(false);
});

it('validates allowlisted fields, numeric bounds, and website protocols', () => {
  expect(parseChanges('beers', { name: '  Lager  ', abv: 5, upc: null })).toEqual({ name: 'Lager', abv: 5, upc: null });
  expect(() => parseChanges('beers', { id: 2 })).toThrow();
  expect(() => parseChanges('beers', { abv: 101 })).toThrow();
  expect(() => parseChanges('breweries', { website: 'javascript:alert(1)' })).toThrow();
  expect(() => parseChanges('styles', { cat_id: 1.5 })).toThrow();
});

it('fingerprints all fields consistently regardless of key ordering', () => {
  expect(fingerprint({ a: 1, b: { x: 2, y: 3 } })).toBe(fingerprint({ b: { y: 3, x: 2 }, a: 1 }));
  expect(fingerprint({ name: 'Beer', archived_at: null })).not.toBe(fingerprint({ name: 'Beer', archived_at: '2026-11-25T00:00:00.000Z' }));
});

it('refuses to archive a parent while active catalog children remain', async () => {
  const tx = { beers: { count: async () => 1 }, styles: { count: async () => 0 }, collection_beers: { count: async () => 0 } };
  await expect(checkArchiveDependencies(tx, 'breweries', 1)).rejects.toThrow(/active beer/);
  await expect(checkArchiveDependencies(tx, 'beers', 1)).resolves.toBeUndefined();
});
