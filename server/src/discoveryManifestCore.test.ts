// Discovery manifest core (decision 006 revisions 1 and 2):
// - canonical serialization known-answer vectors: keys sorted at
//   every depth, arrays in recorded order, no insignificant
//   whitespace, exactly one trailing LF, and a fixed expected
//   SHA-256 for a fixed fixture.
// - build determinism: identical inputs (including id and
//   created_at) produce identical content and hash.
// - payload hashing is key-order independent (the staged payload is
//   JSONB; its key order is not preserved by the database).
// - eligibility: every blocking reason fires; the ok paths produce
//   the manifest record shape for image and no-image candidates.
import * as crypto from 'crypto';
import {
  buildManifestContent, canonicalManifestBytes, canonicalStringify,
  evaluateEligibility, manifestIdFor, manifestSha256, payloadSha256, reviewPayloadSha256,
  CatalogFingerprint, ManifestRecord,
} from './discoveryManifestCore';

describe('canonical serialization', () => {
  it('makes version 2 payload hashes incompatible with older executors', () => {
    const payload = { name: 'Bud Light' };
    expect(reviewPayloadSha256(payload)).not.toBe(payloadSha256(payload));
    expect(reviewPayloadSha256(payload)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('sorts keys at every depth with no whitespace and one trailing LF', () => {
    const content = { c: null, b: { y: 'z', x: [1, 2] }, a: 1 };
    expect(canonicalStringify(content)).toBe('{"a":1,"b":{"x":[1,2],"y":"z"},"c":null}');
    expect(canonicalManifestBytes(content)).toBe('{"a":1,"b":{"x":[1,2],"y":"z"},"c":null}\n');
  });

  it('matches the known-answer SHA-256 for a fixed fixture', () => {
    const content = { c: null, b: { y: 'z', x: [1, 2] }, a: 1 };
    // sha256 of '{"a":1,"b":{"x":[1,2],"y":"z"},"c":null}\n'
    expect(manifestSha256(content)).toBe(
      '83c182380de7d1ac854abe4a6c5bc5462b2cd232336cb0022e792412d6230d12',
    );
    // Independent path: hash the expected byte string directly.
    const expected = crypto
      .createHash('sha256')
      .update('{"a":1,"b":{"x":[1,2],"y":"z"},"c":null}\n')
      .digest('hex');
    expect(manifestSha256(content)).toBe(expected);
  });

  it('preserves array order, drops undefined, and keeps null', () => {
    expect(canonicalStringify({ a: [3, 1, 2], b: undefined, c: null }))
      .toBe('{"a":[3,1,2],"c":null}');
  });

  it('payload hashing is key-order independent and matches its known answer', () => {
    const a = { name: 'Test Ale', brewery_name: 'Acme' };
    const b = { brewery_name: 'Acme', name: 'Test Ale' };
    expect(payloadSha256(a)).toBe(payloadSha256(b));
    expect(payloadSha256(a)).toBe(
      '85c7f6c335aecaf3305a5b1b14d6e7ef2bcfb6ee08887b8aeb26379b9edeff51',
    );
  });
});

const fingerprint: CatalogFingerprint = {
  beers: { count: 2, md5: 'a'.repeat(32) },
  breweries: { count: 1, md5: 'b'.repeat(32) },
  categories: { count: 1, md5: 'd'.repeat(32) },
  styles: { count: 1, md5: 'e'.repeat(32) },
  beverage_images: { count: 0, md5: 'c'.repeat(32) },
};

const record: ManifestRecord = {
  candidate_id: 11,
  candidate_key: 'off:1',
  payload_sha256: 'd'.repeat(64),
  selection_decision_id: 5,
  beer: {
    name: 'Test Ale', brewery_name: 'Acme Brewing', style: 'IPA',
    abv: 6.5, ibu: 60, barcode: '123456789012', description: 'A test ale.',
  },
  brewery: { mode: 'new' },
  style: { mode: 'existing', style_id: 9, category_id: 2 },
  image: null,
};

describe('manifest building', () => {
  it('is deterministic: identical inputs produce identical content and hash', () => {
    const input = {
      id: 'mf-seed-batch-20261123-01',
      batch: { id: 3, slug: 'seed-batch', bundle_sha256: 'e'.repeat(64) },
      fingerprint,
      createdAt: new Date('2026-11-23T10:00:00Z'),
      createdBy: 7,
      records: [record],
    };
    const a = buildManifestContent(input);
    const b = buildManifestContent(JSON.parse(JSON.stringify(input)) && {
      ...input,
      createdAt: new Date('2026-11-23T10:00:00Z'),
      records: [JSON.parse(JSON.stringify(record))],
    });
    expect(canonicalManifestBytes(a)).toBe(canonicalManifestBytes(b));
    expect(manifestSha256(a)).toBe(manifestSha256(b));
    expect(a.record_count).toBe(1);
    expect(a.schema).toBe('discovery-import-manifest/1');
  });

  it('formats manifest ids as mf-<slug>-<yyyymmdd>-<seq>', () => {
    expect(manifestIdFor('reassessment-us', new Date('2026-11-23T23:59:59Z'), 1))
      .toBe('mf-reassessment-us-20261123-01');
    expect(manifestIdFor('batch-2', new Date('2027-01-05T00:00:00Z'), 12))
      .toBe('mf-batch-2-20270105-12');
  });
});

const baseCandidate = {
  id: 11,
  candidate_key: 'off:1',
  payload: { name: 'Test Ale', brewery_name: 'Acme Brewing' },
  name: 'Test Ale',
  brewery_name: 'Acme Brewing',
  style: 'IPA',
  abv: 6.5,
  ibu: 60,
  barcode: '123456789012',
  description: 'A test ale.',
  review_status: 'selected',
  matched_beer_id: null,
  image_url: null,
  image_decision: null,
  image_decision_fetch_id: null,
};

const baseInput = {
  candidate: baseCandidate,
  selectionDecisionId: 5 as number | null,
  unresolvedPairs: 0,
  imageDecision: null as any,
  brewery: { mode: 'new' } as any,
  style: { mode: 'existing', style_id: 9, category_id: 2 } as any,
};

describe('eligibility evaluation', () => {
  it('binds an explicit existing beer target and approved image to an image-only entry', () => {
    const result = evaluateEligibility({
      ...baseInput,
      candidate: { ...baseCandidate, brewery_name: null, matched_beer_id: null, image_url: 'https://images.example/ale.png', image_decision: 'approved', image_decision_fetch_id: 51 },
      reviewIntent: { id: 12, intent: { mode: 'image_only', target_beer_id: 42 } },
      imageDecision: { id: 9, fetch_id: 51, image_ref: 'https://images.example/ale.png', image_sha256: 'f'.repeat(64) },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record).toMatchObject({ kind: 'image_only', target_beer_id: 42, intent_revision_id: 12, image: { decision_id: 9 } });
  });

  it('refuses image-only entries without an approved image', () => {
    const result = evaluateEligibility({ ...baseInput, reviewIntent: { id: 12, intent: { mode: 'image_only', target_beer_id: 42 } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain('approved_image_required');
  });
  it('accepts a selected no-image candidate and snapshots the import payload', () => {
    const result = evaluateEligibility(baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.candidate_key).toBe('off:1');
      expect(result.record.selection_decision_id).toBe(5);
      expect(result.record.image).toBeNull();
      expect(result.record.payload_sha256).toBe(payloadSha256(baseCandidate.payload));
      expect(result.record.beer.name).toBe('Test Ale');
    }
  });

  it('accepts an image candidate only with a current approved decision, bound to its fetch hash', () => {
    const result = evaluateEligibility({
      ...baseInput,
      candidate: {
        ...baseCandidate,
        image_url: 'https://images.example/ale.png',
        image_decision: 'approved',
        image_decision_fetch_id: 51,
      },
      imageDecision: {
        id: 9, fetch_id: 51,
        image_ref: 'https://images.example/ale.png',
        image_sha256: 'f'.repeat(64),
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.image).toEqual({
        decision_id: 9, fetch_id: 51,
        ref: 'https://images.example/ale.png', sha256: 'f'.repeat(64),
      });
    }
  });

  it.each([
    ['not_selected', { candidate: { ...baseCandidate, review_status: 'pending' } }],
    ['selection_decision_missing', { selectionDecisionId: null }],
    ['unresolved_pairs', { unresolvedPairs: 1 }],
    ['already_in_catalog', { candidate: { ...baseCandidate, matched_beer_id: 42 } }],
    ['missing_brewery', { candidate: { ...baseCandidate, brewery_name: '  ' } }],
    ['brewery_ambiguous', { brewery: { mode: 'ambiguous' } }],
    ['style_unresolved', { style: { mode: 'unresolved', style: 'IPA' } }],
    ['image_unverified', {
      candidate: { ...baseCandidate, image_url: 'https://images.example/ale.png' },
    }],
    ['image_rejected', {
      candidate: {
        ...baseCandidate,
        image_url: 'https://images.example/ale.png',
        image_decision: 'rejected',
        image_decision_fetch_id: 51,
      },
    }],
  ])('refuses with reason %s', (reason, overrides) => {
    const result = evaluateEligibility({ ...baseInput, ...overrides } as any);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain(reason);
      expect(result.candidate_id).toBe(11);
    }
  });

  it('reports every failed condition, not just the first', () => {
    const result = evaluateEligibility({
      ...baseInput,
      selectionDecisionId: null,
      unresolvedPairs: 2,
      candidate: { ...baseCandidate, matched_beer_id: 3 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toEqual(
        expect.arrayContaining(['selection_decision_missing', 'unresolved_pairs', 'already_in_catalog']),
      );
    }
  });
});
