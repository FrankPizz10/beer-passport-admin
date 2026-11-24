// Shared pure logic for the discovery bundle builder and the bundle
// ingest (hub decision 006, issues/001-catalog-discovery-hub.md).
//
// A bundle is the immutable transport for one discovery batch:
//   <bundle-dir>/manifest.json     batch metadata + candidates hash
//   <bundle-dir>/candidates.jsonl  one canonical JSON candidate per line
//
// The builder (build-discovery-bundle.ts) converts a staged results
// file (batch 2, the reassessment sets) into a bundle: it maps each
// staged record onto the discovery_candidates columns, derives the
// hold reason deterministically, and extracts ambiguous-pair
// relationships. The ingest (ingest-discovery-bundle.ts) verifies the
// bundle hash, re-checks live-catalog collisions, and loads it in one
// transaction. Everything in this module is pure (no IO, no database),
// so the classification rules are unit-tested directly; the two scripts
// wire these functions to the filesystem and Prisma.
//
// Hold derivation precedence (first match wins), per the phase brief:
//   1. missing_brewery     brewery_name is null or blank in the staged
//                          record.
//   2. origin_uncertain    origin_bucket is 'uncertain', or the origin
//                          evidence carries a conflict marker or a
//                          P17-only marker (decision 005: P17 alone does
//                          not establish US production; conflicting
//                          evidence is held). NOTE: the staged
//                          reassessment files carry the FUSED signal
//                          name 'wikidata_country_p495_else_p17', which
//                          does not by itself distinguish P17-only
//                          records, and the decision 005 QID audit found
//                          zero P17-only and zero conflicting records in
//                          the US set; the markers are detected if a
//                          future harvest emits them explicitly.
//   3. duplicate_unresolved  the record is ambiguous-pair-flagged
//                          (cross_match present, or review_reason is
//                          'ambiguous_cross_source_pair' or
//                          'matches_held_off_record').
//   4. image_unverified    the image status is not verified
//                          (image_status_normalized is not 'verified'
//                          and image_verified is not true). Statuses are
//                          preserved verbatim and never promoted.
//   5. metadata_incomplete style, ABV, or description is missing.
// Records with no hold get hold_reason null. Records from batch 2 carry
// no origin_bucket at all (that batch predates origin classification);
// absence of a bucket is NOT treated as 'uncertain' and draws no origin
// hold. Batch 2 records also carry no image status fields, so under
// rule 4 they land on image_unverified unless another hold fires first;
// the staged file cannot reproduce issue 001's "170 verified images"
// state, which was recorded in the POC manifest, not per record. Both
// gaps are documented in PR_NOTES_PHASE2.md.
import * as crypto from 'crypto';

export const BUNDLE_TOOL = 'build-discovery-bundle';
export const BUNDLE_TOOL_VERSION = '1.0.0';

export const HOLD_REASONS = [
  'missing_brewery',
  'origin_uncertain',
  'market_fit_uncertain',
  'duplicate_unresolved',
  'image_unverified',
  'metadata_incomplete',
  'out_of_scope',
  'other',
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export const sha256Hex = (data: string | Buffer): string =>
  crypto.createHash('sha256').update(data).digest('hex');

// Canonical JSON: object keys sorted lexicographically at every depth,
// no insignificant whitespace. Matches the bundle/manifest conventions
// in issues/001 (RFC 8785 JCS output for this data shape).
export const canonicalStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) as string;
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalStringify(v === undefined ? null : v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
};

// Name/brewery normalization for search and collision checks: lowercase,
// every run of non-alphanumerics becomes one space, trimmed. The ingest
// collision query mirrors this in SQL (see ingest-discovery-bundle.ts);
// keep the two in step.
export const normalizeText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
};

const strOrNull = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.trim() === '' ? null : s;
};

const numOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const intOrNull = (value: unknown): number | null => {
  const n = numOrNull(value);
  return n === null ? null : Math.trunc(n);
};

const boolOrNull = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

const dateOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export type StagedRecord = Record<string, any>;

export const candidateKeyOf = (rec: StagedRecord): string =>
  `${rec.source}:${rec.source_record_id}`;

export const isMissingBrewery = (rec: StagedRecord): boolean =>
  strOrNull(rec.brewery_name) === null;

const evidenceHasMarker = (rec: StagedRecord, marker: string): boolean => {
  const evidence = Array.isArray(rec.origin_evidence) ? rec.origin_evidence : [];
  return evidence.some((e: any) => {
    const signal = String((e && e.signal) || '').toLowerCase();
    const value = String((e && e.value) || '').toLowerCase();
    return signal.includes(marker) || value.includes(marker);
  });
};

export const hasOriginConflictMarker = (rec: StagedRecord): boolean =>
  rec.origin_conflict === true ||
  rec.review_reason === 'origin_conflict' ||
  evidenceHasMarker(rec, 'conflict');

export const hasP17OnlyMarker = (rec: StagedRecord): boolean =>
  rec.origin_p17_only === true ||
  rec.review_reason === 'origin_p17_only' ||
  evidenceHasMarker(rec, 'p17_only') ||
  evidenceHasMarker(rec, 'p17-only');

export const isAmbiguousPairFlagged = (rec: StagedRecord): boolean =>
  !!(rec.cross_match && typeof rec.cross_match === 'object' && rec.cross_match.matched_ref) ||
  rec.review_reason === 'ambiguous_cross_source_pair' ||
  rec.review_reason === 'matches_held_off_record';

export const imageIsVerified = (rec: StagedRecord): boolean =>
  rec.image_status_normalized === 'verified' || rec.image_verified === true;

export type HoldDerivation = { hold_reason: HoldReason | null; hold_note: string | null };

export const deriveHoldReason = (rec: StagedRecord): HoldDerivation => {
  if (isMissingBrewery(rec)) {
    return { hold_reason: 'missing_brewery', hold_note: 'brewery_name is empty in the staged record.' };
  }
  if (rec.origin_bucket === 'uncertain') {
    return { hold_reason: 'origin_uncertain', hold_note: 'Origin bucket is uncertain; no US production or US market evidence (decision 005).' };
  }
  if (hasOriginConflictMarker(rec)) {
    return { hold_reason: 'origin_uncertain', hold_note: 'Conflicting origin evidence in the staged record; held per decision 005.' };
  }
  if (hasP17OnlyMarker(rec)) {
    return { hold_reason: 'origin_uncertain', hold_note: 'P17-only origin evidence; P17 alone does not establish US production (decision 005).' };
  }
  if (isAmbiguousPairFlagged(rec)) {
    return { hold_reason: 'duplicate_unresolved', hold_note: 'Ambiguous cross-source pair; the rival is staged as a pair row for side-by-side review.' };
  }
  if (!imageIsVerified(rec)) {
    return { hold_reason: 'image_unverified', hold_note: 'Image status is not verified; statuses are preserved as staged and never promoted.' };
  }
  if (strOrNull(rec.style) === null || numOrNull(rec.abv) === null || strOrNull(rec.description) === null) {
    return { hold_reason: 'metadata_incomplete', hold_note: 'Style, ABV, or description is missing in the staged record.' };
  }
  return { hold_reason: null, hold_note: null };
};

export type BundlePair = {
  external_ref: string;
  comparison: string | null;
  method: string | null;
  score: number | null;
};

export const extractPair = (rec: StagedRecord): BundlePair | null => {
  const cm = rec.cross_match;
  if (!cm || typeof cm !== 'object' || !cm.matched_ref) return null;
  return {
    external_ref: String(cm.matched_ref),
    comparison: typeof cm.comparison === 'string' ? cm.comparison : (rec.review_reason || null),
    method: typeof cm.method === 'string' ? cm.method : null,
    score: numOrNull(cm.score),
  };
};

// One candidates.jsonl line, mapped onto the discovery_candidates
// columns (batch_id and collision outcome are added at ingest).
export type BundleCandidate = {
  candidate_key: string;
  payload: StagedRecord;
  name: string;
  brewery_name: string | null;
  style: string | null;
  abv: number | null;
  ibu: number | null;
  description: string | null;
  barcode: string | null;
  source: string;
  source_record_id: string;
  source_url: string | null;
  retrieved_at: string | null;
  tier: string | null;
  origin_bucket: string | null;
  origin_evidence: unknown;
  image_url: string | null;
  image_source: string | null;
  image_tier: string | null;
  image_status: string | null;
  image_status_normalized: string | null;
  image_verified: boolean | null;
  image_flag_reason: string | null;
  image_license: string | null;
  image_page_url: string | null;
  image_width: number | null;
  image_height: number | null;
  hold_reason: HoldReason | null;
  hold_note: string | null;
  normalized_name: string;
  normalized_brewery: string | null;
  pair: BundlePair | null;
};

export const mapRecord = (rec: StagedRecord): BundleCandidate => {
  const hold = deriveHoldReason(rec);
  const brewery = strOrNull(rec.brewery_name);
  return {
    candidate_key: candidateKeyOf(rec),
    payload: rec,
    name: String(rec.name ?? ''),
    brewery_name: brewery,
    style: strOrNull(rec.style),
    abv: numOrNull(rec.abv),
    ibu: numOrNull(rec.ibu),
    description: strOrNull(rec.description),
    barcode: strOrNull(rec.barcode),
    source: String(rec.source ?? ''),
    source_record_id: String(rec.source_record_id ?? ''),
    source_url: strOrNull(rec.source_url),
    retrieved_at: dateOrNull(rec.retrieved_at),
    tier: strOrNull(rec.tier),
    origin_bucket: strOrNull(rec.origin_bucket),
    origin_evidence: Array.isArray(rec.origin_evidence) ? rec.origin_evidence : null,
    image_url: strOrNull(rec.image_url),
    image_source: strOrNull(rec.image_source),
    image_tier: strOrNull(rec.image_tier),
    image_status: strOrNull(rec.image_status),
    image_status_normalized: strOrNull(rec.image_status_normalized),
    image_verified: boolOrNull(rec.image_verified),
    image_flag_reason: strOrNull(rec.image_flag_reason),
    image_license: strOrNull(rec.image_license),
    image_page_url: strOrNull(rec.image_page_url),
    image_width: intOrNull(rec.image_width),
    image_height: intOrNull(rec.image_height),
    hold_reason: hold.hold_reason,
    hold_note: hold.hold_note,
    normalized_name: normalizeText(rec.name),
    normalized_brewery: brewery === null ? null : normalizeText(brewery),
    pair: extractPair(rec),
  };
};

export type BundleManifest = {
  slug: string;
  title: string | null;
  source: string;
  source_summary: string | null;
  created_at: string;
  record_count: number;
  candidates_sha256: string;
  tool: string;
  tool_version: string;
  holds_by_reason: Record<string, number>;
  pairs: number;
};

export type BuiltBundle = {
  manifest: BundleManifest;
  jsonl: string;
  summary: { records: number; holds_by_reason: Record<string, number>; pairs: number };
};

export const buildBundleData = (
  records: StagedRecord[],
  opts: { slug: string; source: string; title?: string; sourceSummary?: string; limit?: number; createdAt?: string },
): BuiltBundle => {
  const sliced = opts.limit !== undefined ? records.slice(0, opts.limit) : records;
  const candidates = sliced.map(mapRecord);
  const lines = candidates.map((c) => canonicalStringify(c));
  const jsonl = lines.length ? lines.join('\n') + '\n' : '';
  const holds: Record<string, number> = {};
  let pairs = 0;
  for (const c of candidates) {
    if (c.hold_reason) holds[c.hold_reason] = (holds[c.hold_reason] || 0) + 1;
    if (c.pair) pairs += 1;
  }
  const manifest: BundleManifest = {
    slug: opts.slug,
    title: opts.title ?? null,
    source: opts.source,
    source_summary: opts.sourceSummary ?? null,
    created_at: opts.createdAt ?? new Date().toISOString(),
    record_count: candidates.length,
    candidates_sha256: sha256Hex(jsonl),
    tool: BUNDLE_TOOL,
    tool_version: BUNDLE_TOOL_VERSION,
    holds_by_reason: holds,
    pairs,
  };
  return { manifest, jsonl, summary: { records: candidates.length, holds_by_reason: holds, pairs } };
};

export type BundleVerification = { ok: boolean; errors: string[]; candidates: BundleCandidate[] };

export const verifyBundle = (manifest: any, jsonl: string): BundleVerification => {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['manifest is not a JSON object'], candidates: [] };
  }
  if (typeof manifest.slug !== 'string' || !manifest.slug) errors.push('manifest.slug is missing');
  if (typeof manifest.candidates_sha256 !== 'string') errors.push('manifest.candidates_sha256 is missing');
  if (!Number.isInteger(manifest.record_count)) errors.push('manifest.record_count is missing');
  if (errors.length) return { ok: false, errors, candidates: [] };

  const actualHash = sha256Hex(jsonl);
  if (actualHash !== manifest.candidates_sha256) {
    errors.push(`candidates.jsonl SHA-256 mismatch: manifest records ${manifest.candidates_sha256}, file hashes to ${actualHash}`);
  }
  const lines = jsonl.split('\n').filter((l) => l.trim() !== '');
  if (lines.length !== manifest.record_count) {
    errors.push(`record count mismatch: manifest records ${manifest.record_count}, file has ${lines.length} lines`);
  }
  const candidates: BundleCandidate[] = [];
  lines.forEach((line, i) => {
    try {
      candidates.push(JSON.parse(line));
    } catch {
      errors.push(`candidates.jsonl line ${i + 1} is not valid JSON`);
    }
  });
  return { ok: errors.length === 0, errors, candidates };
};

export type IngestDecision = 'insert' | 'noop' | 'refuse_slug_conflict';

export const decideIngest = (
  manifest: BundleManifest,
  existingByHash: { slug: string } | null,
  existingBySlug: { bundle_sha256: string } | null,
): IngestDecision => {
  if (existingByHash) return 'noop';
  if (existingBySlug && existingBySlug.bundle_sha256 !== manifest.candidates_sha256) {
    return 'refuse_slug_conflict';
  }
  if (existingBySlug) return 'noop';
  return 'insert';
};
