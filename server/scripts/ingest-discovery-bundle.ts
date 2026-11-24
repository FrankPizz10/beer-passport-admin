// Operator tool: ingest one discovery bundle into the discovery
// staging tables (hub decision 006, issues/001-catalog-discovery-hub.md).
//
//   DATABASE_URL_ADMIN_LOADER=postgresql://... \
//     npx ts-node --transpile-only scripts/ingest-discovery-bundle.ts <bundle-dir>
//
// Connection: DATABASE_URL_ADMIN_LOADER, the operator/migration
// identity. The script REFUSES to run without it: the API's viewer role
// is SELECT-only and there is no API ingest path by design. This script
// is run by a human operator from their own machine (never on the
// Lightsail host, which runs no discovery work), against an approved
// target only.
//
// Behavior:
//   * Verifies candidates.jsonl against the bundle manifest (SHA-256
//     and record count) before touching the database; a tampered or
//     truncated bundle is refused with the mismatch printed.
//   * Idempotent: if a batch with the same bundle SHA-256 already
//     exists, prints a no-op report and exits 0. If the slug exists
//     with a DIFFERENT hash, refuses (bundles are immutable; a changed
//     bundle is a new batch, not an edit).
//   * Re-checks live-catalog collisions per candidate (barcode equality
//     against beers.upc, else exact normalized name + brewery match)
//     and records the outcome on the candidate row (dedupe_outcome,
//     matched_beer_id) instead of dropping the candidate.
//   * Loads the batch, its candidates, and its pairs in ONE
//     transaction. Pair rivals staged in another batch (or this one)
//     are resolved to candidate rows when present; the external_ref is
//     always kept.
// Prints a JSON report: { slug, status, inserted, collisions_flagged,
// holds_by_reason, pairs_inserted }.
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import {
  BundleCandidate, BundleManifest, decideIngest, verifyBundle,
} from './discoveryBundleCore';

export type IngestCandidateRow = Omit<BundleCandidate, 'pair'> & {
  dedupe_outcome: 'no_match' | 'collision' | 'ambiguous';
  matched_beer_id: number | null;
};

export type IngestPairRow = {
  candidate_key: string;
  external_ref: string;
  comparison: string | null;
  method: string | null;
  score: number | null;
};

export type IngestReport = {
  slug: string;
  bundle_sha256: string;
  status: 'inserted' | 'noop';
  inserted: number;
  collisions_flagged: number;
  holds_by_reason: Record<string, number>;
  pairs_inserted: number;
};

// Everything runIngest needs from the outside world. Production wires
// these to Prisma; tests wire mocks, so the verification, idempotency,
// and collision logic runs with no database.
export type IngestDeps = {
  findBatchByHash: (sha256: string) => Promise<{ id: number; slug: string } | null>;
  findBatchBySlug: (slug: string) => Promise<{ id: number; bundle_sha256: string } | null>;
  findBeerByBarcode: (barcode: string) => Promise<{ id: number } | null>;
  findBeerByNormalizedNameBrewery: (
    normalizedName: string,
    normalizedBrewery: string,
  ) => Promise<{ id: number } | null>;
  insertBundle: (data: {
    manifest: BundleManifest;
    candidates: IngestCandidateRow[];
    pairs: IngestPairRow[];
  }) => Promise<{ pairs_inserted: number }>;
};

export const runIngest = async (
  manifestRaw: unknown,
  jsonl: string,
  deps: IngestDeps,
): Promise<IngestReport> => {
  const verification = verifyBundle(manifestRaw, jsonl);
  if (!verification.ok) {
    throw new Error('bundle verification failed: ' + verification.errors.join('; '));
  }
  const manifest = manifestRaw as BundleManifest;
  const candidates = verification.candidates;

  const byHash = await deps.findBatchByHash(manifest.candidates_sha256);
  const bySlug = byHash ? null : await deps.findBatchBySlug(manifest.slug);
  const decision = decideIngest(manifest, byHash, bySlug);
  if (decision === 'refuse_slug_conflict') {
    throw new Error(
      `slug "${manifest.slug}" already exists with a different bundle hash; ` +
      'bundles are immutable, so a changed bundle must be ingested under a new slug.',
    );
  }
  const holds: Record<string, number> = {};
  for (const c of candidates) {
    if (c.hold_reason) holds[c.hold_reason] = (holds[c.hold_reason] || 0) + 1;
  }
  if (decision === 'noop') {
    return {
      slug: manifest.slug,
      bundle_sha256: manifest.candidates_sha256,
      status: 'noop',
      inserted: 0,
      collisions_flagged: 0,
      holds_by_reason: holds,
      pairs_inserted: 0,
    };
  }

  const rows: IngestCandidateRow[] = [];
  const pairs: IngestPairRow[] = [];
  let collisions = 0;
  for (const candidate of candidates) {
    const { pair, ...row } = candidate;
    let matched: { id: number } | null = null;
    if (row.barcode) {
      matched = await deps.findBeerByBarcode(row.barcode);
    }
    if (!matched && row.normalized_brewery) {
      matched = await deps.findBeerByNormalizedNameBrewery(row.normalized_name, row.normalized_brewery);
    }
    const dedupe_outcome = matched ? 'collision' : pair ? 'ambiguous' : 'no_match';
    if (matched) collisions += 1;
    rows.push({ ...row, dedupe_outcome, matched_beer_id: matched ? matched.id : null });
    if (pair) {
      pairs.push({ candidate_key: row.candidate_key, ...pair });
    }
  }

  const { pairs_inserted } = await deps.insertBundle({ manifest, candidates: rows, pairs });
  return {
    slug: manifest.slug,
    bundle_sha256: manifest.candidates_sha256,
    status: 'inserted',
    inserted: rows.length,
    collisions_flagged: collisions,
    holds_by_reason: holds,
    pairs_inserted,
  };
};

const main = async () => {
  const bundleDir = process.argv[2];
  if (!bundleDir) {
    console.error('Usage: ingest-discovery-bundle.ts <bundle-dir>');
    process.exit(2);
  }
  const loaderUrl = process.env.DATABASE_URL_ADMIN_LOADER || '';
  if (!loaderUrl) {
    console.error('REFUSING TO INGEST: DATABASE_URL_ADMIN_LOADER is not set (the operator/migration identity is required; the API roles cannot write staging rows).');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'));
  const jsonl = fs.readFileSync(path.join(bundleDir, 'candidates.jsonl'), 'utf8');

  const prisma = new PrismaClient({ datasources: { db: { url: loaderUrl } } });
  try {
    const report = await runIngest(manifest, jsonl, {
      findBatchByHash: (sha256) =>
        prisma.discovery_batches.findUnique({ where: { bundle_sha256: sha256 }, select: { id: true, slug: true } }),
      findBatchBySlug: (slug) =>
        prisma.discovery_batches.findUnique({ where: { slug }, select: { id: true, bundle_sha256: true } }),
      findBeerByBarcode: async (barcode) => {
        const rows = await prisma.beers.findMany({ where: { upc: barcode }, select: { id: true }, take: 1 });
        return rows[0] || null;
      },
      findBeerByNormalizedNameBrewery: async (normalizedName, normalizedBrewery) => {
        const rows = await prisma.$queryRaw<Array<{ id: number }>>`
          SELECT b.id FROM beers b
          JOIN breweries br ON br.id = b.brewery_id
          WHERE trim(regexp_replace(lower(b.name), '[^a-z0-9]+', ' ', 'g')) = ${normalizedName}
            AND trim(regexp_replace(lower(br.name), '[^a-z0-9]+', ' ', 'g')) = ${normalizedBrewery}
          LIMIT 1`;
        return rows[0] || null;
      },
      insertBundle: async ({ manifest: m, candidates, pairs }) => {
        let pairsInserted = 0;
        await prisma.$transaction(async (tx: any) => {
          const batch = await tx.discovery_batches.create({
            data: {
              slug: m.slug,
              title: m.title,
              source: m.source,
              source_summary: m.source_summary,
              manifest: m as any,
              bundle_sha256: m.candidates_sha256,
              candidates_sha256: m.candidates_sha256,
              record_count: candidates.length,
              ingested_by: process.env.USER || null,
            },
          });
          const idByKey = new Map<string, number>();
          for (const c of candidates) {
            const created = await tx.discovery_candidates.create({
              data: {
                batch_id: batch.id,
                candidate_key: c.candidate_key,
                payload: c.payload as any,
                name: c.name,
                brewery_name: c.brewery_name,
                style: c.style,
                abv: c.abv,
                ibu: c.ibu,
                description: c.description,
                barcode: c.barcode,
                source: c.source,
                source_record_id: c.source_record_id,
                source_url: c.source_url,
                retrieved_at: c.retrieved_at ? new Date(c.retrieved_at) : null,
                tier: c.tier,
                origin_bucket: c.origin_bucket,
                origin_evidence: c.origin_evidence === null ? undefined : (c.origin_evidence as any),
                image_url: c.image_url,
                image_source: c.image_source,
                image_tier: c.image_tier,
                image_status: c.image_status,
                image_status_normalized: c.image_status_normalized,
                image_verified: c.image_verified,
                image_flag_reason: c.image_flag_reason,
                image_license: c.image_license,
                image_page_url: c.image_page_url,
                image_width: c.image_width,
                image_height: c.image_height,
                hold_reason: c.hold_reason,
                hold_note: c.hold_note,
                dedupe_outcome: c.dedupe_outcome,
                matched_beer_id: c.matched_beer_id,
                normalized_name: c.normalized_name,
                normalized_brewery: c.normalized_brewery,
              },
              select: { id: true },
            });
            idByKey.set(c.candidate_key, created.id);
          }
          for (const p of pairs) {
            const candidateId = idByKey.get(p.candidate_key);
            if (!candidateId) continue;
            let rivalId = idByKey.get(p.external_ref) || null;
            if (!rivalId) {
              const rival = await tx.discovery_candidates.findFirst({
                where: { candidate_key: p.external_ref },
                select: { id: true },
              });
              rivalId = rival ? rival.id : null;
            }
            await tx.discovery_candidate_pairs.create({
              data: {
                batch_id: batch.id,
                candidate_id: candidateId,
                candidate_id_b: rivalId,
                external_ref: p.external_ref,
                comparison: p.comparison,
                method: p.method,
                score: p.score,
              },
            });
            pairsInserted += 1;
          }
        });
        return { pairs_inserted: pairsInserted };
      },
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
};

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
