// Manifest core for the discovery hub import gate (hub decision 006
// revisions 1 and 2, issues/001-catalog-discovery-hub.md section 4).
// Pure logic shared by the manifest API (src/routes/
// discoveryManifests.ts) and the operator import executor
// (server/scripts/import-discovery-manifest.ts): canonical
// serialization, hashing, the catalog baseline fingerprint, and the
// per-candidate eligibility evaluation. No IO and no database access
// live here (the fingerprint SQL strings are data; callers run them).
//
// Canonical serialization matches the bundle convention in
// scripts/discoveryBundleCore.ts (the same algorithm, duplicated here
// because src/ does not import from scripts/; the two implementations
// must produce identical output for identical input): object keys
// sorted lexicographically at every depth, arrays in recorded order,
// no insignificant whitespace, strings minimally escaped, integers
// bare. A manifest's hashed bytes are canonicalStringify(content)
// plus exactly one trailing LF.
//
// The catalog baseline fingerprint (issues/001 section 4, check 5):
// for each of beers, breweries, and beverage_images, the row count
// plus an MD5 over the content-bearing columns in id order, so a
// count-preserving change (a rename, a brewery re-assignment, a
// status flip) changes the fingerprint even though counts are
// unchanged. DEVIATION from the issue text, forced by the actual
// catalog schema: the issue names an `updated_at` column for beers
// and breweries, but the catalog's timestamp column on those tables
// is `last_mod` (see server/prisma/schema.prisma); beverage_images
// does have updated_at and uses it. The fingerprint covers exactly:
//   beers:           id, name, brewery_id, last_mod
//   breweries:       id, name, last_mod
//   beverage_images: id, beverage_id, status, updated_at
import * as crypto from 'crypto';
import { ReviewIntent } from './discoveryReviewIntent';

export const MANIFEST_SCHEMA = 'discovery-import-manifest/1';
export const REVIEW_MANIFEST_SCHEMA = 'discovery-import-manifest/2';
export const MANIFEST_GENERATOR = 'discovery-manifest-builder';
export const MANIFEST_GENERATOR_VERSION = '1.0.0';

// Fixed key for the transaction-scoped advisory lock every catalog
// import takes (pg_advisory_xact_lock). Any value works; it must
// never change once imports exist, because its only job is to make
// two imports of the catalog serialize.
export const CATALOG_IMPORT_ADVISORY_LOCK_KEY = 777001239;

export const sha256Hex = (data: string | Buffer): string =>
  crypto.createHash('sha256').update(data).digest('hex');

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

export const canonicalManifestBytes = (content: unknown): string =>
  canonicalStringify(content) + '\n';

export const manifestSha256 = (content: unknown): string =>
  sha256Hex(canonicalManifestBytes(content));

// The staged payload hash recorded per record: SHA-256 of the
// candidate payload's canonical serialization. The executor recomputes
// it from the staged row inside its transaction; any staged edit
// since the build changes it.
export const payloadSha256 = (payload: unknown): string =>
  sha256Hex(canonicalStringify(payload === undefined ? null : payload));

// Version 2 deliberately uses a domain-separated payload hash. An older
// executor, which does not inspect schema versions, compares this value
// with the v1 hash and refuses rather than importing v2 records under v1
// semantics. This is not a replacement for the v2 revision checks.
export const reviewPayloadSha256 = (payload: unknown): string =>
  sha256Hex('discovery-manifest-v2:' + payloadSha256(payload));

export const manifestDateStamp = (date: Date): string => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
};

export const manifestIdFor = (batchSlug: string, date: Date, seq: number): string =>
  `mf-${batchSlug}-${manifestDateStamp(date)}-${String(seq).padStart(2, '0')}`;

// Name/brewery normalization for brewery and style resolution:
// lowercase, every run of non-alphanumerics becomes one space,
// trimmed. Identical to scripts/discoveryBundleCore.ts normalizeText
// (duplicated for the same reason as canonicalStringify: src/ does
// not import from scripts/, and the two must agree).
export const normalizeText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
};

export const MANIFEST_ID_PATTERN = /^mf-.+-\d{8}-\d{2,}$/;

// --- Catalog baseline fingerprint -------------------------------------

export interface TableFingerprint {
  count: number;
  md5: string;
}

export interface CatalogFingerprint {
  beers: TableFingerprint;
  breweries: TableFingerprint;
  beverage_images: TableFingerprint;
}

const fingerprintSql = (table: string, rowExpression: string): string =>
  `SELECT count(*)::int AS count, md5(coalesce(string_agg(md5(${rowExpression}), '' ORDER BY id), '')) AS md5 FROM ${table}`;

export const FINGERPRINT_SQL: Record<keyof CatalogFingerprint, string> = {
  beers: fingerprintSql(
    'beers',
    "concat_ws('|', id::text, name, coalesce(brewery_id::text, ''), coalesce(last_mod::text, ''))",
  ),
  breweries: fingerprintSql(
    'breweries',
    "concat_ws('|', id::text, name, coalesce(last_mod::text, ''))",
  ),
  beverage_images: fingerprintSql(
    'beverage_images',
    "concat_ws('|', id::text, beverage_id::text, status, coalesce(updated_at::text, ''))",
  ),
};

export type RawQuery = (sql: string) => Promise<any[]>;

// Runs the three fingerprint queries through the caller's query
// function (a Prisma client's $queryRawUnsafe, on whichever identity
// the caller holds; inside the import transaction it MUST be the
// transaction client so the fingerprint is read from the import's
// own snapshot).
export const computeCatalogFingerprint = async (queryRaw: RawQuery): Promise<CatalogFingerprint> => {
  const out = {} as CatalogFingerprint;
  for (const table of ['beers', 'breweries', 'beverage_images'] as const) {
    const rows = await queryRaw(FINGERPRINT_SQL[table]);
    const row = rows[0] || { count: 0, md5: '' };
    out[table] = { count: Number(row.count), md5: String(row.md5) };
  }
  return out;
};

export const fingerprintsEqual = (a: unknown, b: unknown): boolean =>
  canonicalStringify(a) === canonicalStringify(b);

export const fingerprintDiff = (expected: any, actual: any): string[] => {
  const diffs: string[] = [];
  for (const table of ['beers', 'breweries', 'beverage_images']) {
    const e = expected?.[table];
    const a = actual?.[table];
    if (!e || !a || e.count !== a.count || e.md5 !== a.md5) {
      diffs.push(
        `${table}: manifest recorded count=${e?.count} md5=${e?.md5}, catalog now count=${a?.count} md5=${a?.md5}`,
      );
    }
  }
  return diffs;
};

// --- Manifest content ---------------------------------------------------

export interface ManifestImageDisposition {
  decision_id: number;
  fetch_id: number;
  ref: string;
  sha256: string;
}

export type ManifestBreweryResolution =
  | { mode: 'existing'; brewery_id: number }
  | { mode: 'new' };

export type ManifestStyleResolution =
  | { mode: 'existing'; style_id: number; category_id: number | null }
  | { mode: 'none' };

export interface ManifestRecord {
  kind?: 'new_beer' | 'image_only';
  intent_revision_id?: number | null;
  target_beer_id?: number;
  candidate_id: number;
  candidate_key: string;
  payload_sha256: string;
  selection_decision_id: number;
  beer: {
    name: string;
    brewery_name: string;
    style: string | null;
    abv: number | null;
    ibu: number | null;
    barcode: string | null;
    description: string | null;
  };
  brewery: ManifestBreweryResolution;
  style: ManifestStyleResolution;
  image: ManifestImageDisposition | null;
}

export interface ManifestContent {
  schema: string;
  id: string;
  batch: { id: number; slug: string; bundle_sha256: string };
  generator: { name: string; version: string };
  created_at: string;
  created_by: number | null;
  record_count: number;
  catalog_fingerprint: CatalogFingerprint;
  records: ManifestRecord[];
}

// Builds the canonical content object. Records MUST already be in
// candidate_key order (the caller sorts); the builder records them in
// the order given, and the import assigns new beer ids in this order.
export const buildManifestContent = (input: {
  id: string;
  batch: { id: number; slug: string; bundle_sha256: string };
  fingerprint: CatalogFingerprint;
  createdAt: Date;
  createdBy: number | null;
  records: ManifestRecord[];
  schema?: string;
}): ManifestContent => ({
  schema: input.schema ?? MANIFEST_SCHEMA,
  id: input.id,
  batch: input.batch,
  generator: { name: MANIFEST_GENERATOR, version: MANIFEST_GENERATOR_VERSION },
  created_at: input.createdAt.toISOString(),
  created_by: input.createdBy,
  record_count: input.records.length,
  catalog_fingerprint: input.fingerprint,
  records: input.records,
});

// --- Eligibility ----------------------------------------------------------

export type BreweryLookup =
  | { mode: 'existing'; brewery_id: number }
  | { mode: 'new' }
  | { mode: 'ambiguous' };

export type StyleLookup =
  | { mode: 'existing'; style_id: number; category_id: number | null }
  | { mode: 'none' }
  | { mode: 'unresolved'; style: string };

export interface EligibilityInput {
  candidate: {
    id: number;
    candidate_key: string;
    payload: unknown;
    name: string;
    brewery_name: string | null;
    style: string | null;
    abv: number | null;
    ibu: number | null;
    barcode: string | null;
    description: string | null;
    review_status: string;
    matched_beer_id: number | null;
    image_url: string | null;
    image_decision: string | null;
    image_decision_fetch_id: number | null;
  };
  // The id of the candidate's latest selection-gate decision when
  // that decision is the one that set review_status to 'selected'
  // (decision 'select', to_status 'selected'); null otherwise.
  selectionDecisionId: number | null;
  unresolvedPairs: number;
  // The binding image decision row when the candidate's current image
  // decision is 'approved'; null otherwise.
  imageDecision: {
    id: number;
    fetch_id: number;
    image_ref: string;
    image_sha256: string;
  } | null;
  brewery: BreweryLookup;
  style: StyleLookup;
  reviewIntent?: { id: number; intent: ReviewIntent } | null;
}

export type EligibilityResult =
  | { ok: true; record: ManifestRecord }
  | { ok: false; candidate_id: number; candidate_key: string; reasons: string[] };

// Evaluates ONE selected candidate for manifest inclusion. Every
// failed condition is reported (never just the first), and a manifest
// is built only when every selected candidate evaluates ok: a
// manifest never silently includes or excludes (decision 006).
export const evaluateEligibility = (input: EligibilityInput): EligibilityResult => {
  const c = input.candidate;
  const reasons: string[] = [];
  if (c.review_status !== 'selected') reasons.push('not_selected');
  if (input.selectionDecisionId === null) reasons.push('selection_decision_missing');
  if (input.unresolvedPairs > 0) reasons.push('unresolved_pairs');
  const intent = input.reviewIntent?.intent;
  const imageOnly = intent?.mode === 'image_only';
  if (!imageOnly && c.matched_beer_id !== null && c.matched_beer_id !== undefined) reasons.push('already_in_catalog');
  const breweryName = typeof c.brewery_name === 'string' ? c.brewery_name.trim() : '';
  if (!imageOnly && !breweryName) reasons.push('missing_brewery');
  if (!imageOnly && input.brewery.mode === 'ambiguous') reasons.push('brewery_ambiguous');
  if (!imageOnly && input.style.mode === 'unresolved') reasons.push('style_unresolved');

  let image: ManifestImageDisposition | null = null;
  const hasImage = typeof c.image_url === 'string' && c.image_url.trim() !== '';
  if (hasImage) {
    if (c.image_decision === 'rejected') {
      reasons.push('image_rejected');
    } else if (c.image_decision !== 'approved' || !input.imageDecision) {
      reasons.push('image_unverified');
    } else {
      image = {
        decision_id: input.imageDecision.id,
        fetch_id: input.imageDecision.fetch_id,
        ref: input.imageDecision.image_ref,
        sha256: input.imageDecision.image_sha256,
      };
    }
  }
  if (imageOnly && !image) reasons.push('approved_image_required');

  if (reasons.length > 0) {
    return { ok: false, candidate_id: c.id, candidate_key: c.candidate_key, reasons };
  }
  return {
    ok: true,
    record: {
      ...(input.reviewIntent ? {
        kind: imageOnly ? 'image_only' as const : 'new_beer' as const,
        intent_revision_id: input.reviewIntent.id,
        ...(intent?.mode === 'image_only' ? { target_beer_id: intent.target_beer_id } : {}),
      } : {}),
      candidate_id: c.id,
      candidate_key: c.candidate_key,
      payload_sha256: payloadSha256(c.payload),
      selection_decision_id: input.selectionDecisionId as number,
      beer: {
        name: c.name,
        brewery_name: c.brewery_name as string,
        style: c.style,
        abv: c.abv,
        ibu: c.ibu,
        barcode: c.barcode,
        description: c.description,
      },
      brewery: input.brewery.mode === 'existing'
        ? { mode: 'existing', brewery_id: input.brewery.brewery_id }
        : { mode: 'new' },
      style: input.style.mode === 'existing'
        ? { mode: 'existing', style_id: input.style.style_id, category_id: input.style.category_id }
        : { mode: 'none' },
      image,
    },
  };
};
