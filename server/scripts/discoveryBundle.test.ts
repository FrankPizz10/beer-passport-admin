// Unit tests for the discovery bundle builder core and ingest logic.
// All IO is mocked: no filesystem, no database, no network.
import {
  buildBundleData, canonicalStringify, decideIngest, deriveHoldReason,
  extractPair, mapRecord, normalizeText, sha256Hex, verifyBundle,
} from './discoveryBundleCore';
import { runIngest, IngestDeps } from './ingest-discovery-bundle';

const usRecord = (overrides: Record<string, unknown> = {}) => ({
  name: 'Hazy Wonder',
  brewery_name: 'Example Brewing',
  style: 'New England IPA',
  abv: 6.4,
  ibu: 45,
  description: 'A hazy IPA.',
  barcode: '012345678905',
  source: 'wikidata',
  source_record_id: 'Q123',
  source_url: 'https://www.wikidata.org/wiki/Q123',
  retrieved_at: '2026-11-23T00:00:00Z',
  tier: '1',
  origin_bucket: 'us_produced',
  origin_evidence: [{ signal: 'wikidata_country_p495_else_p17', value: 'United States' }],
  image_url: 'https://example.com/hazy.jpg',
  image_source: 'wikidata',
  image_tier: '1',
  image_status: 'verified',
  image_status_normalized: 'verified',
  image_verified: true,
  ...overrides,
});

describe('canonicalStringify', () => {
  it('sorts keys at every depth and emits no whitespace', () => {
    expect(canonicalStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }))
      .toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it('drops undefined object properties like JSON.stringify', () => {
    expect(canonicalStringify({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe('normalizeText', () => {
  it('lowercases, collapses punctuation runs, and trims', () => {
    expect(normalizeText('Brew Free!  Or-Die IPA')).toBe('brew free or die ipa');
    expect(normalizeText(null)).toBe('');
  });
});

describe('deriveHoldReason precedence', () => {
  it('returns no hold for a complete verified US record', () => {
    expect(deriveHoldReason(usRecord())).toEqual({ hold_reason: null, hold_note: null });
  });
  it('missing brewery beats every other hold', () => {
    const rec = usRecord({ brewery_name: '', origin_bucket: 'uncertain', image_status_normalized: 'none', image_verified: false });
    expect(deriveHoldReason(rec).hold_reason).toBe('missing_brewery');
  });
  it('uncertain origin bucket draws origin_uncertain', () => {
    expect(deriveHoldReason(usRecord({ origin_bucket: 'uncertain' })).hold_reason).toBe('origin_uncertain');
  });
  it('a P17-only marker draws origin_uncertain even in a US bucket', () => {
    const rec = usRecord({ origin_evidence: [{ signal: 'wikidata_country_p17_only', value: 'United States' }] });
    expect(deriveHoldReason(rec).hold_reason).toBe('origin_uncertain');
  });
  it('an origin conflict marker draws origin_uncertain', () => {
    const rec = usRecord({ origin_evidence: [{ signal: 'origin_conflict', value: 'US vs CA' }] });
    expect(deriveHoldReason(rec).hold_reason).toBe('origin_uncertain');
  });
  it('duplicate beats image and metadata holds', () => {
    const rec = usRecord({
      review_reason: 'ambiguous_cross_source_pair',
      cross_match: { comparison: 'off_vs_craftcans512', matched_ref: 'craftcans_github:958', method: 'fuzzy', score: 50.6 },
      image_status_normalized: 'none', image_verified: false, abv: null,
    });
    expect(deriveHoldReason(rec).hold_reason).toBe('duplicate_unresolved');
  });
  it('unverified image draws image_unverified before metadata', () => {
    const rec = usRecord({ image_status_normalized: 'gate_passed_unverified', image_verified: false, abv: null });
    expect(deriveHoldReason(rec).hold_reason).toBe('image_unverified');
  });
  it('a record with no image at all is not verified', () => {
    const rec = usRecord({ image_status_normalized: 'none', image_verified: false, image_url: null });
    expect(deriveHoldReason(rec).hold_reason).toBe('image_unverified');
  });
  it('missing metadata is the last hold', () => {
    expect(deriveHoldReason(usRecord({ description: null })).hold_reason).toBe('metadata_incomplete');
    expect(deriveHoldReason(usRecord({ abv: null })).hold_reason).toBe('metadata_incomplete');
    expect(deriveHoldReason(usRecord({ style: null })).hold_reason).toBe('metadata_incomplete');
  });
  it('batch-2 shaped records (no origin bucket, no image status) draw no origin hold', () => {
    const rec = {
      name: 'Brew Free! or Die IPA', brewery_name: '21st Amendment Brewery',
      style: 'American IPA', abv: 7.0, ibu: 65, description: null, barcode: null,
      source: 'craftcans_github', source_record_id: '10', source_url: 'https://example.com/beers.csv',
      retrieved_at: '2026-11-23T00:00:00Z', tier: 'C',
      image_url: null, image_source: null, image_tier: null,
    };
    // No origin_bucket field at all: not 'uncertain', so the first hold
    // that fires is image_unverified (no image status was staged).
    expect(deriveHoldReason(rec).hold_reason).toBe('image_unverified');
  });
});

describe('extractPair and mapRecord', () => {
  it('extracts the pair from cross_match data', () => {
    const rec = usRecord({ cross_match: { comparison: 'wd_vs_off', matched_ref: 'openfoodfacts:123', method: 'fuzzy', score: 88.2 } });
    expect(extractPair(rec)).toEqual({ external_ref: 'openfoodfacts:123', comparison: 'wd_vs_off', method: 'fuzzy', score: 88.2 });
  });
  it('returns null without cross_match', () => {
    expect(extractPair(usRecord())).toBeNull();
  });
  it('maps fields and builds the candidate key', () => {
    const mapped = mapRecord(usRecord());
    expect(mapped.candidate_key).toBe('wikidata:Q123');
    expect(mapped.normalized_name).toBe('hazy wonder');
    expect(mapped.normalized_brewery).toBe('example brewing');
    expect(mapped.image_status_normalized).toBe('verified');
  });
  it('maps an empty brewery name to null', () => {
    expect(mapRecord(usRecord({ brewery_name: '' })).brewery_name).toBeNull();
  });
});

describe('buildBundleData and verifyBundle', () => {
  it('builds a verifiable bundle and honors --limit', () => {
    const built = buildBundleData([usRecord(), usRecord({ source_record_id: 'Q124' })], { slug: 'seed', source: 'test', limit: 1 });
    expect(built.summary.records).toBe(1);
    const v = verifyBundle(built.manifest, built.jsonl);
    expect(v.ok).toBe(true);
    expect(v.candidates).toHaveLength(1);
    expect(built.manifest.candidates_sha256).toBe(sha256Hex(built.jsonl));
  });
  it('detects a tampered candidates file by hash', () => {
    const built = buildBundleData([usRecord()], { slug: 'seed', source: 'test' });
    const tampered = built.jsonl.replace('Hazy Wonder', 'Hazy WondeR');
    const v = verifyBundle(built.manifest, tampered);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/SHA-256 mismatch/);
  });
  it('detects a truncated candidates file by count', () => {
    const built = buildBundleData([usRecord(), usRecord({ source_record_id: 'Q124' })], { slug: 'seed', source: 'test' });
    const truncated = built.jsonl.split('\n')[0] + '\n';
    const v = verifyBundle(built.manifest, truncated);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/count mismatch/);
  });
});

describe('decideIngest', () => {
  const manifest: any = { slug: 'seed', candidates_sha256: 'abc' };
  it('inserts when nothing exists', () => {
    expect(decideIngest(manifest, null, null)).toBe('insert');
  });
  it('no-ops when the bundle hash is already ingested', () => {
    expect(decideIngest(manifest, { slug: 'seed' }, null)).toBe('noop');
  });
  it('refuses when the slug exists with a different hash', () => {
    expect(decideIngest(manifest, null, { bundle_sha256: 'different' })).toBe('refuse_slug_conflict');
  });
});

describe('runIngest with mocked IO', () => {
  const deps = (overrides: Partial<IngestDeps> = {}): IngestDeps => ({
    findBatchByHash: jest.fn(async () => null),
    findBatchBySlug: jest.fn(async () => null),
    findBeerByBarcode: jest.fn(async () => null),
    findBeerByNormalizedNameBrewery: jest.fn(async () => null),
    insertBundle: jest.fn(async () => ({ pairs_inserted: 0 })),
    ...overrides,
  });

  it('no-ops without inserting when the hash exists', async () => {
    const built = buildBundleData([usRecord()], { slug: 'seed', source: 'test' });
    const d = deps({ findBatchByHash: jest.fn(async () => ({ id: 1, slug: 'seed' })) });
    const report = await runIngest(built.manifest, built.jsonl, d);
    expect(report.status).toBe('noop');
    expect(d.insertBundle).not.toHaveBeenCalled();
  });

  it('refuses a tampered bundle before any database call', async () => {
    const built = buildBundleData([usRecord()], { slug: 'seed', source: 'test' });
    const d = deps();
    await expect(runIngest(built.manifest, built.jsonl.replace('Hazy', 'Xazy'), d))
      .rejects.toThrow(/SHA-256 mismatch/);
    expect(d.findBatchByHash).not.toHaveBeenCalled();
  });

  it('flags barcode collisions and ambiguous pairs on the inserted rows', async () => {
    const records = [
      usRecord(),
      usRecord({
        source_record_id: 'Q999', barcode: null, name: 'Dax Light',
        cross_match: { comparison: 'off_vs_craftcans512', matched_ref: 'craftcans_github:958', method: 'fuzzy', score: 50.6 },
        review_reason: 'ambiguous_cross_source_pair',
      }),
    ];
    const built = buildBundleData(records, { slug: 'seed', source: 'test' });
    let captured: any = null;
    const d = deps({
      findBeerByBarcode: jest.fn(async () => ({ id: 42 })),
      insertBundle: jest.fn(async (data: any) => { captured = data; return { pairs_inserted: data.pairs.length }; }),
    });
    const report = await runIngest(built.manifest, built.jsonl, d);
    expect(report.status).toBe('inserted');
    expect(report.inserted).toBe(2);
    expect(report.collisions_flagged).toBe(1);
    expect(report.pairs_inserted).toBe(1);
    expect(captured.candidates[0].dedupe_outcome).toBe('collision');
    expect(captured.candidates[0].matched_beer_id).toBe(42);
    expect(captured.candidates[1].dedupe_outcome).toBe('ambiguous');
    expect(captured.pairs[0].external_ref).toBe('craftcans_github:958');
  });
});
