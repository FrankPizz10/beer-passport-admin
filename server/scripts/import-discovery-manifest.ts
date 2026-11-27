// Operator tool: import ONE approved discovery manifest into the
// catalog (hub decision 006 revisions 1 and 2, issues/001 section 4).
//
//   DATABASE_URL_ADMIN_LOADER=<redacted> \
//     npx ts-node --transpile-only scripts/import-discovery-manifest.ts \
//       --manifest mf-<batch-slug>-<yyyymmdd>-<seq> --sha256 <64 hex> [--dry-run]
//
// Connection: DATABASE_URL_ADMIN_LOADER, the operator/migration
// identity. The script REFUSES to run without it. The API roles
// cannot do this: the reviewer role's grants stop at the four
// manifest approval columns, and marking a manifest imported is
// deliberately not among them.
//
// THE GATE (decision 006): this executor is the only code path that
// turns a manifest into catalog rows, and it refuses - before any
// write - unless ALL of the following hold, verified inside the one
// import transaction:
//   * the manifest exists and its status is 'approved' (a draft,
//     void, or already-imported manifest is refused by name);
//   * the operator-supplied --sha256 equals the manifest's stored
//     sha256, equals the approved_sha256 Frank approved, and equals
//     the recomputed hash of the stored canonical content.
// A production import additionally requires Frank's approval of the
// exact manifest id + sha256 recorded out of band (see
// docs/DISCOVERY_HUB_RUNBOOK.md); the --sha256 argument IS that
// recorded hash, and this tool never invents it.
//
// VALIDITY THROUGH THE WRITE: the import runs as ONE transaction at
// REPEATABLE READ. It first takes a transaction-scoped advisory lock
// on the fixed catalog-import key (a concurrent import waits, then
// re-checks against the new baseline and aborts as stale), then takes
// SHARE ROW EXCLUSIVE table locks on beers, breweries, and
// beverage_images for the rest of the transaction: the advisory lock
// alone only serializes imports against each other, while these
// table locks also hold off NORMAL catalog writes (every INSERT,
// UPDATE, or DELETE takes a conflicting ROW EXCLUSIVE lock), so no
// catalog change can slip in between the fingerprint and collision
// checks and the import's own writes. Plain reads are unaffected,
// and a catalog write already in flight finishes before the lock is
// granted, so the checks never run against a half-written catalog.
// It then locks the manifest's candidate rows SELECT ... FOR UPDATE,
// and runs all five revalidation checks INSIDE the transaction, in
// order:
// One abort shape deserves a note: under REPEATABLE READ, SELECT
// ... FOR UPDATE on a candidate row that a concurrent import (or
// decision write) already updated and committed raises a
// serialization failure (SQLSTATE 40001, Prisma P2034) instead of
// returning the new row version. runImport maps that failure to a
// 'stale' refusal: inside this transaction it can only mean the
// ground moved after the snapshot, which is exactly the stale case,
// and nothing was written.
//   1. manifest approval + hash binding (above);
//   2. every candidate is still in the decided state the manifest
//      recorded: review_status 'selected', the selection decision is
//      still the latest and unchanged, the staged payload hash still
//      matches, and the image decision state (approved decision id,
//      fetch id, hash) is unchanged;
//   3. no candidate has gained an unresolved duplicate pair or a
//      live-catalog collision (barcode, or normalized name +
//      brewery) since the manifest was built;
//   4. referenced breweries, styles, and categories still resolve as
//      the manifest expects (an 'existing' row still exists with the
//      recorded category; a 'new' brewery name still has no live
//      namesake);
//   5. the live catalog fingerprint (row count + MD5 over
//      content-bearing columns per table, computed by
//      src/discoveryManifestCore.ts) still equals the fingerprint
//      recorded when the manifest was built.
// Any failure aborts the whole transaction with a specific message
// and imports nothing.
//
// WRITES (all inside the same transaction): new breweries the
// manifest marks as new (manifest order, deduplicated within the
// manifest), beers with NEW ids assigned above the current max beer
// id in manifest order, beverage_images for approved attached images
// (each image is RE-FETCHED through the Phase 4 restricted fetcher
// and re-hashed inside the transaction; a mismatch aborts - nothing
// is silently degraded to pending), candidates marked imported with
// their new beer id, and the manifest marked imported with an
// 'import' audit event carrying the report. On a hash match the
// beverage_images row is written directly as status 'approved' with
// verified_at set: the Phase 4 decision IS the approval, and the row
// names the candidate image decision in its attribution provenance
// (the catalog schema has no dedicated provenance column; see the
// runbook).
//
// IMAGE STORAGE: in the real write path (never in --dry-run), the
// re-fetched, hash-verified bytes are uploaded to the private image
// bucket BEFORE the beverage_images row is written, and the row's
// storage_key is the returned content-addressed S3 key
// (discovery/<2-char shard>/<sha256>, see
// src/discoveryImageUpload.ts) - the bare key the API's presigned-GET
// read path resolves. source_url keeps carrying the origin URL. The
// upload runs under this process's OPERATOR identity, never the
// API's GetObject-only identity. One ordering fact is unavoidable:
// the S3 PUT is not part of the database transaction, so an abort
// after a successful PUT (a later image failing, a commit failure)
// leaves an orphan object. Content addressing makes that orphan
// harmless: it holds exactly the verified bytes under their hash,
// is referenced by no row, and a retry of the import PUTs the same
// bytes to the same key. An upload failure after the uploader's
// bounded retries aborts the import as IMPORT REFUSED
// [image_upload] and the database transaction rolls back; a
// manifest with images but no configured uploader refuses the same
// way rather than storing a source URL as storage_key.
//
// --dry-run runs the lock, all five checks, the image re-fetch and
// hash verification, and the full payload validation, then rolls
// back and prints the would-be report (id assignments are the ids
// that WOULD be assigned).
//
// Prints a JSON ImportReport on stdout. Refusals print
// "IMPORT REFUSED [<check>]: <message>" on stderr and exit 1;
// argument and configuration refusals exit 2.
import { Prisma, PrismaClient } from '@prisma/client';
import { fetchImageRestricted, FetchedImage, FetchResult } from '../src/discoveryImageFetch';
import { discoveryObjectKey, getDefaultDiscoveryUploader, UploadImageFn } from '../src/discoveryImageUpload';
import {
  CATALOG_IMPORT_ADVISORY_LOCK_KEY, MANIFEST_SCHEMA, REVIEW_MANIFEST_SCHEMA, ManifestContent, ManifestRecord,
  computeCatalogFingerprint, fingerprintDiff, fingerprintsEqual,
  manifestSha256, normalizeText, payloadSha256, reviewPayloadSha256, canonicalStringify,
} from '../src/discoveryManifestCore';
import { parseReviewIntent } from '../src/discoveryReviewIntent';

export class ImportRefusedError extends Error {
  check: string;
  constructor(check: string, message: string) {
    super(message);
    this.check = check;
  }
}

const refused = (check: string, message: string) => new ImportRefusedError(check, message);

export interface ImportIdAssignment {
  candidate_id: number;
  candidate_key: string;
  beer_id: number;
  brewery_id: number;
  image_id: number | null;
}

export interface ImportReport {
  manifest_id: string;
  sha256: string;
  dry_run: boolean;
  beers_inserted: number;
  breweries_inserted: number;
  images_inserted: number;
  id_assignments: ImportIdAssignment[];
}

export interface ImportDeps {
  fetchImage: (url: string) => Promise<FetchResult>;
  // Uploads hash-verified image bytes to the private image bucket and
  // resolves to the object key stored in beverage_images.storage_key.
  // Optional in the type so refusal-path and dry-run callers need not
  // provide one, but a REAL import of a manifest that carries images
  // refuses (image_upload) when it is absent: silently storing the
  // source URL instead is exactly the gap this closes. The CLI wires
  // the real S3 uploader from the operator environment; tests inject
  // a stub. Uploads run under the OPERATOR identity of this process,
  // never under the API's GetObject-only signing identity.
  uploadImage?: UploadImageFn;
}

const CATALOG_SEQUENCES: Array<{ table: string; sequence: string }> = [
  { table: 'breweries', sequence: 'breweries_id_seq' },
  { table: 'beers', sequence: 'beers_id_seq' },
  { table: 'beverage_images', sequence: 'beverage_images_id_seq' },
];

// Align each catalog id sequence with its table's current maximum id
// so the inserts below receive fresh ids above every existing row.
// Two safety properties, both load-bearing:
//   * NEVER BACKWARDS: the target is GREATEST(table max, the
//     sequence's own last_value), so a sequence that is already ahead
//     of the table (ids reserved by another tool, a restored dump,
//     manual inserts with explicit ids) keeps its position instead
//     of being rewound to the max, where a later nextval could hand
//     out an id that something else already treats as taken.
//   * FAILURE ABORTS: any alignment error (a missing sequence, a
//     permissions failure) is rethrown as a refusal. It is never
//     swallowed: an import that cannot prove its id space is aligned
//     must not write catalog rows.
export const alignCatalogSequences = async (tx: any): Promise<void> => {
  for (const { table, sequence } of CATALOG_SEQUENCES) {
    try {
      await tx.$queryRaw`SELECT setval(${sequence}::regclass, GREATEST(
        COALESCE((SELECT MAX(id) FROM ${Prisma.raw(table)}), 0),
        (SELECT last_value FROM ${Prisma.raw(sequence)})
      ), true) AS value`;
    } catch (e) {
      throw refused(
        'sequence_alignment',
        `could not align the ${table} id sequence (${sequence}) with the table maximum; the import aborted before writing catalog rows. Cause: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isSerializationFailure = (e: unknown): boolean => {
  if (!e || typeof e !== 'object') return false;
  const code = (e as { code?: unknown }).code;
  if (code === 'P2034') return true;
  const message = e instanceof Error ? e.message : String(e);
  return /could not serialize|40001|deadlock detected/i.test(message);
};

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export const runImport = async (
  prisma: PrismaClient,
  opts: { manifestId: string; expectedSha256: string; dryRun?: boolean },
  deps: ImportDeps,
): Promise<ImportReport> => {
  if (!opts.manifestId || typeof opts.manifestId !== 'string') {
    throw refused('arguments', 'a manifest id is required (--manifest).');
  }
  if (!/^[0-9a-f]{64}$/.test(opts.expectedSha256 || '')) {
    throw refused('arguments', 'an expected sha256 (64 lowercase hex) is required (--sha256): the hash Frank approved, recorded out of band.');
  }
  const dryRun = opts.dryRun === true;

  class DryRunRollback extends Error {}

  let report: ImportReport | null = null;
  try {
    await prisma.$transaction(
      async (tx: any) => {
        // Validity through the write: one snapshot for checks AND
        // writes, and imports serialize on the advisory lock.
        const lockRows = await tx.$queryRaw`
          SELECT pg_try_advisory_xact_lock(${CATALOG_IMPORT_ADVISORY_LOCK_KEY}) AS locked
        `;
        let locked = lockRows?.[0]?.locked === true;
        for (let attempt = 0; !locked && attempt < 600; attempt += 1) {
          await sleep(500);
          const again = await tx.$queryRaw`
            SELECT pg_try_advisory_xact_lock(${CATALOG_IMPORT_ADVISORY_LOCK_KEY}) AS locked
          `;
          locked = again?.[0]?.locked === true;
        }
        if (!locked) {
          throw refused('lock', 'could not acquire the catalog-import advisory lock after 5 minutes; another import may be stuck.');
        }

        // Hold off normal catalog writes for the rest of the
        // transaction (see the header): SHARE ROW EXCLUSIVE on the
        // three fingerprint/collision tables conflicts with the ROW
        // EXCLUSIVE lock every INSERT/UPDATE/DELETE takes, while
        // plain SELECTs keep working and this transaction's own
        // inserts are unaffected. Acquired after the advisory lock
        // so concurrent imports keep a single lock order.
        await tx.$executeRaw`
          LOCK TABLE beers, breweries, categories, styles, beverage_images
          IN SHARE ROW EXCLUSIVE MODE
        `;

        const row = await tx.discovery_import_manifests.findUnique({
          where: { id: opts.manifestId },
        });
        if (!row) throw refused('check1', `manifest ${opts.manifestId} does not exist.`);

        // CHECK 1: approval + hash binding.
        if (row.status !== 'approved') {
          throw refused(
            'check1',
            `manifest ${row.id} is ${row.status}; only an approved manifest can be imported. ` +
            (row.status === 'draft'
              ? 'It has not been approved by Frank (the approval endpoint writes status, approved_by, approved_at, approved_sha256 atomically).'
              : row.status === 'void'
                ? 'A voided manifest can never be imported.'
                : 'It has already been imported.'),
          );
        }
        const recomputed = manifestSha256(row.manifest);
        if (recomputed !== row.sha256) {
          throw refused('check1', `manifest ${row.id} content no longer hashes to its stored sha256 (stored ${row.sha256}, recomputed ${recomputed}); the manifest row was tampered with.`);
        }
        if (row.approved_sha256 !== row.sha256) {
          throw refused('check1', `manifest ${row.id} approved_sha256 (${row.approved_sha256}) does not equal the manifest hash (${row.sha256}).`);
        }
        if (opts.expectedSha256 !== row.sha256) {
          throw refused('check1', `the supplied --sha256 (${opts.expectedSha256}) does not equal the manifest hash (${row.sha256}); refusing to import a manifest other than the one that was approved.`);
        }

        const content = row.manifest as ManifestContent;
        if (!content || !Array.isArray(content.records) || content.id !== row.id) {
          throw refused('check1', `manifest ${row.id} content is malformed (id or records missing).`);
        }
        if (content.schema !== MANIFEST_SCHEMA && content.schema !== REVIEW_MANIFEST_SCHEMA) {
          throw refused('check1', `manifest ${row.id} has an unsupported schema version.`);
        }
        const records: ManifestRecord[] = content.records;
        const candidateIds = records.map((r) => r.candidate_id);
        if (!candidateIds.every(isInt) || candidateIds.length === 0) {
          throw refused('check1', `manifest ${row.id} records carry no valid candidate ids.`);
        }

        // Lock the candidate rows for the duration of the import: a
        // concurrent review decision on one of them blocks until the
        // import commits, then lands on the post-import state. The
        // lock query also RETURNS the two fields an import or a
        // decision can change (review_status, matched_beer_id): under
        // REPEATABLE READ a plain SELECT would keep this
        // transaction's original snapshot, but rows returned by
        // SELECT ... FOR UPDATE after waiting reflect the latest
        // committed versions, so a concurrent import that commits
        // first is seen here and the stale import aborts on check 2
        // instead of writing duplicates.
        const candidateLockRows = await tx.$queryRaw`
          SELECT id, review_status, matched_beer_id
          FROM discovery_candidates
          WHERE id IN (${Prisma.join(candidateIds)})
          ORDER BY id FOR UPDATE
        `;
        const lockById = new Map<number, any>(
          (Array.isArray(candidateLockRows) ? candidateLockRows : []).map((r: any) => [Number(r.id), r]),
        );
        const candidates = await tx.discovery_candidates.findMany({
          where: { id: { in: candidateIds } },
        });
        const candidateById = new Map<number, any>(candidates.map((c: any) => [c.id, c]));

        const imageDecisionByCandidate = new Map<number, any>();
        // CHECK 2: decided state unchanged.
        for (const record of records) {
          const candidate = candidateById.get(record.candidate_id);
          if (!candidate) {
            throw refused('check2', `candidate ${record.candidate_id} (${record.candidate_key}) no longer exists.`);
          }
          const lockedRow = lockById.get(record.candidate_id);
          const currentStatus = lockedRow?.review_status ?? candidate.review_status;
          if (currentStatus !== 'selected') {
            throw refused('check2', `candidate ${record.candidate_id} (${record.candidate_key}) is ${currentStatus}, not selected; its decision state changed after the manifest was built.`);
          }
          const currentPayloadHash = content.schema === REVIEW_MANIFEST_SCHEMA ? reviewPayloadSha256(candidate.payload) : payloadSha256(candidate.payload);
          if (currentPayloadHash !== record.payload_sha256) {
            throw refused('check2', `candidate ${record.candidate_id} (${record.candidate_key}) staged payload changed after the manifest was built (payload hash mismatch).`);
          }
          if (content.schema === REVIEW_MANIFEST_SCHEMA) {
            const revision = await tx.discovery_review_intents.findFirst({ where: { candidate_id: record.candidate_id }, orderBy: { id: 'desc' } });
            if ((revision?.id ?? null) !== (record.intent_revision_id ?? null)) {
              throw refused('check2', `candidate ${record.candidate_id} review intent changed after the manifest was built.`);
            }
            if (revision) {
              let intent;
              try { intent = parseReviewIntent(revision.intent); }
              catch { throw refused('check2', `candidate ${record.candidate_id} has an invalid review intent.`); }
              if (intent.mode !== record.kind || (intent.mode === 'image_only' && (record.target_beer_id !== intent.target_beer_id || !record.image)) ||
                  (intent.mode === 'new_beer' && canonicalStringify(intent.beer) !== canonicalStringify(record.beer))) {
                throw refused('check2', `candidate ${record.candidate_id} review intent does not match the manifest.`);
              }
            } else if (record.kind !== undefined || record.target_beer_id !== undefined) {
              throw refused('check2', `candidate ${record.candidate_id} has no matching intent revision.`);
            } else {
              const staged = { name: candidate.name, brewery_name: candidate.brewery_name,
                style: candidate.style, abv: candidate.abv, ibu: candidate.ibu,
                barcode: candidate.barcode, description: candidate.description };
              if (canonicalStringify(staged) !== canonicalStringify(record.beer)) {
                throw refused('check2', `candidate ${record.candidate_id} staged beer fields changed after the manifest was built.`);
              }
            }
          } else if (record.kind !== undefined || record.intent_revision_id !== undefined || record.target_beer_id !== undefined) {
            throw refused('check1', `manifest ${row.id} contains unsupported version 1 fields.`);
          }
          const latest = await tx.discovery_decisions.findFirst({
            where: { candidate_id: record.candidate_id, pair_id: null },
            orderBy: { id: 'desc' },
          });
          if (!latest || latest.id !== record.selection_decision_id || latest.decision !== 'select' || latest.to_status !== 'selected') {
            throw refused('check2', `candidate ${record.candidate_id} (${record.candidate_key}) selection decision changed after the manifest was built (manifest recorded decision ${record.selection_decision_id}, latest is ${latest ? latest.id : 'none'}).`);
          }
          if (record.image) {
            if (candidate.image_decision !== 'approved' || candidate.image_decision_fetch_id !== record.image.fetch_id) {
              throw refused('check2', `candidate ${record.candidate_id} (${record.candidate_key}) image decision state changed after the manifest was built.`);
            }
            const decision = await tx.discovery_image_decisions.findUnique({
              where: { id: record.image.decision_id },
            });
            if (!decision || decision.decision !== 'approved' || decision.fetch_id !== record.image.fetch_id
              || decision.image_sha256 !== record.image.sha256 || decision.image_ref !== record.image.ref) {
              throw refused('check2', `candidate ${record.candidate_id} (${record.candidate_key}) image decision ${record.image.decision_id} no longer matches the manifest record.`);
            }
            imageDecisionByCandidate.set(record.candidate_id, decision);
          } else if (candidate.image_decision === 'approved') {
            throw refused('check2', `candidate ${record.candidate_id} (${record.candidate_key}) gained an approved image decision after the manifest was built (the manifest records no image).`);
          }
        }

        // CHECK 3: no new unresolved pair, no live-catalog collision.
        for (const record of records) {
          const candidate = candidateById.get(record.candidate_id);
          const pendingPairs = await tx.discovery_candidate_pairs.count({
            where: {
              status: 'pending',
              OR: [{ candidate_id: record.candidate_id }, { candidate_id_b: record.candidate_id }],
            },
          });
          if (pendingPairs > 0) {
            throw refused('check3', `candidate ${record.candidate_id} (${record.candidate_key}) has ${pendingPairs} unresolved duplicate pair(s) again.`);
          }
          if (content.schema === REVIEW_MANIFEST_SCHEMA && record.kind === 'image_only') continue;
          const lockedRow = lockById.get(record.candidate_id);
          const currentMatched = lockedRow ? lockedRow.matched_beer_id : candidate.matched_beer_id;
          if (currentMatched !== null && currentMatched !== undefined) {
            throw refused('check3', `candidate ${record.candidate_id} (${record.candidate_key}) is now matched to live beer ${currentMatched}.`);
          }
          const reviewedBeer = content.schema === REVIEW_MANIFEST_SCHEMA ? record.beer : null;
          const barcode = reviewedBeer ? reviewedBeer.barcode : candidate.barcode;
          if (barcode) {
            const byBarcode = await tx.beers.findFirst({ where: { upc: barcode } });
            if (byBarcode) {
              throw refused('check3', `candidate ${record.candidate_id} (${record.candidate_key}) barcode ${barcode} now collides with live beer ${byBarcode.id}.`);
            }
          }
          const normalizedName = reviewedBeer ? normalizeText(reviewedBeer.name) : candidate.normalized_name;
          const normalizedBrewery = reviewedBeer ? normalizeText(reviewedBeer.brewery_name) : candidate.normalized_brewery;
          if (normalizedName && normalizedBrewery) {
            const clash = await tx.$queryRaw`
              SELECT b.id FROM beers b JOIN breweries br ON br.id = b.brewery_id
              WHERE trim(regexp_replace(lower(b.name), '[^a-z0-9]+', ' ', 'g')) = ${normalizedName}
                AND trim(regexp_replace(lower(br.name), '[^a-z0-9]+', ' ', 'g')) = ${normalizedBrewery}
              LIMIT 1
            `;
            if (Array.isArray(clash) && clash.length > 0) {
              throw refused('check3', `candidate ${record.candidate_id} (${record.candidate_key}) now collides with live beer ${clash[0].id} by normalized name + brewery.`);
            }
          }
        }

        // CHECK 4: brewery / style / category resolution unchanged.
        const breweryIdByRecord = new Map<number, number | 'new'>();
        const imageOnlyTargetByRecord = new Map<number, any>();
        const imageOnlyKeys = new Set<string>();
        for (const record of records) {
          if (content.schema === REVIEW_MANIFEST_SCHEMA && record.kind === 'image_only') {
            const target = await tx.beers.findUnique({ where: { id: record.target_beer_id }, select: { id: true, brewery_id: true, archived_at: true } });
            if (!target || target.archived_at) throw refused('check4', `candidate ${record.candidate_id} target beer no longer exists or is archived.`);
            if (!record.image) throw refused('check4', `candidate ${record.candidate_id} has no approved image.`);
            const imageKey = `${target.id}:${record.image.sha256}`;
            if (imageOnlyKeys.has(imageKey)) throw refused('check4', `manifest contains the same image more than once for beer ${target.id}.`);
            imageOnlyKeys.add(imageKey);
            const existingImage = await tx.beverage_images.findFirst({ where: { beverage_id: target.id, storage_key: discoveryObjectKey(record.image.sha256) }, select: { id: true } });
            if (existingImage) throw refused('check4', `candidate ${record.candidate_id} image already exists on beer ${target.id}.`);
            imageOnlyTargetByRecord.set(record.candidate_id, target);
            continue;
          }
          if (record.brewery.mode === 'existing') {
            const brewery = await tx.breweries.findUnique({ where: { id: record.brewery.brewery_id } });
            if (!brewery || brewery.archived_at) {
              throw refused('check4', `candidate ${record.candidate_id} (${record.candidate_key}) references brewery ${record.brewery.brewery_id}, which no longer exists.`);
            }
            breweryIdByRecord.set(record.candidate_id, brewery.id);
          } else {
            const wanted = normalizeText(record.beer.brewery_name);
            const namesakes = await tx.$queryRaw`
              SELECT id FROM breweries
              WHERE trim(regexp_replace(lower(name), '[^a-z0-9]+', ' ', 'g')) = ${wanted}
              LIMIT 1
            `;
            if (Array.isArray(namesakes) && namesakes.length > 0) {
              throw refused('check4', `candidate ${record.candidate_id} (${record.candidate_key}) expects to create brewery "${record.beer.brewery_name}", but a live brewery with that name (id ${namesakes[0].id}) now exists; the manifest is stale.`);
            }
            breweryIdByRecord.set(record.candidate_id, 'new');
          }
          if (record.style.mode === 'existing') {
            const style = await tx.styles.findUnique({ where: { id: record.style.style_id } });
            if (!style || style.archived_at) {
              throw refused('check4', `candidate ${record.candidate_id} (${record.candidate_key}) references style ${record.style.style_id}, which no longer exists.`);
            }
            if ((style.cat_id ?? null) !== record.style.category_id) {
              throw refused('check4', `candidate ${record.candidate_id} (${record.candidate_key}) style ${record.style.style_id} now belongs to category ${style.cat_id}, not the recorded ${record.style.category_id}.`);
            }
          }
        }

        // CHECK 5: catalog fingerprint unchanged since the build.
        const fingerprint = await computeCatalogFingerprint((sql: Prisma.Sql) => tx.$queryRaw(sql));
        if (!fingerprintsEqual(fingerprint, content.catalog_fingerprint)) {
          const diffs = fingerprintDiff(content.catalog_fingerprint, fingerprint);
          throw refused('check5', `the live catalog changed after the manifest was built (fingerprint mismatch: ${diffs.join('; ')}). The approval is stale; rebuild and re-approve.`);
        }

        // Image re-fetch + re-hash (the write phase's binding proof):
        // the bytes that would be published must still hash to the
        // approved hash. A mismatch aborts; nothing degrades. The
        // full fetched image (bytes included) is kept: the real
        // write path uploads exactly these verified bytes to S3.
        const fetchedByCandidate = new Map<number, FetchedImage>();
        for (const record of records) {
          if (!record.image) continue;
          const result = await deps.fetchImage(record.image.ref);
          if (result.outcome !== 'success') {
            throw refused('image_refetch', `candidate ${record.candidate_id} (${record.candidate_key}) image re-fetch failed (${result.outcome}: ${result.detail}); import aborted.`);
          }
          if (result.image.sha256 !== record.image.sha256) {
            throw refused('image_refetch', `candidate ${record.candidate_id} (${record.candidate_key}) image bytes changed after approval (manifest ${record.image.sha256}, re-fetched ${result.image.sha256}); import aborted. The Phase 4 decision no longer binds.`);
          }
          fetchedByCandidate.set(record.candidate_id, result.image);
        }

        // Payload plan (shared by the real write and the dry run).
        const newBreweryNames: string[] = [];
        const newBreweryKeyByRecord = new Map<number, string>();
        for (const record of records) {
          if (breweryIdByRecord.get(record.candidate_id) === 'new') {
            const key = normalizeText(record.beer.brewery_name);
            if (!newBreweryNames.includes(key)) newBreweryNames.push(key);
            newBreweryKeyByRecord.set(record.candidate_id, key);
          }
        }
        const displayNameByKey = new Map<string, string>();
        for (const record of records) {
          const key = newBreweryKeyByRecord.get(record.candidate_id);
          if (key && !displayNameByKey.has(key)) displayNameByKey.set(key, record.beer.brewery_name);
        }

        if (dryRun) {
          const maxBeer = await tx.$queryRaw`SELECT coalesce(max(id), 0)::int AS max_id FROM beers`;
          const maxBrewery = await tx.$queryRaw`SELECT coalesce(max(id), 0)::int AS max_id FROM breweries`;
          let nextBeer = Number(maxBeer[0].max_id);
          let nextBrewery = Number(maxBrewery[0].max_id);
          const wouldBeBreweryId = new Map<string, number>();
          for (const key of newBreweryNames) wouldBeBreweryId.set(key, ++nextBrewery);
          const assignments: ImportIdAssignment[] = records.map((record) => {
            const target = imageOnlyTargetByRecord.get(record.candidate_id);
            if (target) return { candidate_id: record.candidate_id, candidate_key: record.candidate_key, beer_id: target.id, brewery_id: target.brewery_id, image_id: null };
            const existing = breweryIdByRecord.get(record.candidate_id);
            const breweryId = existing === 'new'
              ? (wouldBeBreweryId.get(newBreweryKeyByRecord.get(record.candidate_id) as string) as number)
              : (existing as number);
            return {
              candidate_id: record.candidate_id,
              candidate_key: record.candidate_key,
              beer_id: ++nextBeer,
              brewery_id: breweryId,
              image_id: null,
            };
          });
          report = {
            manifest_id: row.id,
            sha256: row.sha256,
            dry_run: true,
            beers_inserted: records.length - imageOnlyTargetByRecord.size,
            breweries_inserted: newBreweryNames.length,
            images_inserted: records.filter((r) => r.image).length,
            id_assignments: assignments,
          };
          throw new DryRunRollback();
        }

        // Upload the verified image bytes to the private bucket
        // (real write path only: the dry-run branch above has
        // already rolled back, so a dry run performs no upload).
        // Uploads complete before any catalog row is written, so an
        // upload failure aborts with nothing in the database to
        // unwind; the transaction still rolls back as a whole. See
        // the header for the orphan-object semantics of a PUT that
        // succeeded before a later abort.
        const imageRecords = records.filter((r) => r.image);
        if (imageRecords.length > 0 && typeof deps.uploadImage !== 'function') {
          throw refused(
            'image_upload',
            `manifest ${row.id} carries ${imageRecords.length} approved image(s) but no image uploader is configured for this process (the operator environment must set ADMIN_IMAGE_BUCKET and ADMIN_IMAGE_REGION or AWS_REGION so the verified bytes can be uploaded to the private image bucket). Refusing to import: storing a source URL as storage_key would leave the imported images unresolvable through the presigned read path.`,
          );
        }
        const storageKeyByCandidate = new Map<number, string>();
        for (const record of imageRecords) {
          const fetched = fetchedByCandidate.get(record.candidate_id) as FetchedImage;
          let key: string;
          try {
            key = await (deps.uploadImage as UploadImageFn)({
              bytes: fetched.bytes,
              sha256: fetched.sha256,
              contentType: fetched.contentType,
            });
          } catch (e) {
            throw refused(
              'image_upload',
              `candidate ${record.candidate_id} (${record.candidate_key}) image upload failed (${e instanceof Error ? e.message : String(e)}); import aborted and the database transaction rolls back. Any object already PUT by this import is a harmless content-addressed orphan (see the header note).`,
            );
          }
          if (!key || typeof key !== 'string') {
            throw refused('image_upload', `candidate ${record.candidate_id} (${record.candidate_key}) image upload returned no object key; import aborted.`);
          }
          storageKeyByCandidate.set(record.candidate_id, key);
        }

        // Align the id sequences with the current table maxima so
        // new ids are assigned above the current max, in manifest
        // order. Never moves a sequence backwards, and any alignment
        // failure aborts the import (see alignCatalogSequences).
        await alignCatalogSequences(tx);

        const now = new Date();
        const createdBreweryId = new Map<string, number>();
        for (const key of newBreweryNames) {
          const created = await tx.breweries.create({
            data: { name: displayNameByKey.get(key) as string, descript: '' },
          });
          createdBreweryId.set(key, created.id);
        }

        const assignments: ImportIdAssignment[] = [];
        let imagesInserted = 0;
        for (const record of records) {
          const candidate = candidateById.get(record.candidate_id);
          const target = imageOnlyTargetByRecord.get(record.candidate_id);
          const existing = breweryIdByRecord.get(record.candidate_id);
          const breweryId = target ? target.brewery_id : existing === 'new'
            ? (createdBreweryId.get(newBreweryKeyByRecord.get(record.candidate_id) as string) as number)
            : (existing as number);
          const beer = target ?? await tx.beers.create({
            data: {
              name: record.beer.name,
              brewery_id: breweryId,
              cat_id: record.style.mode === 'existing' ? record.style.category_id : null,
              style_id: record.style.mode === 'existing' ? record.style.style_id : null,
              abv: record.beer.abv,
              ibu: record.beer.ibu,
              upc: record.beer.barcode,
              descript: record.beer.description,
            },
          });
          let imageId: number | null = null;
          if (record.image) {
            const decision = imageDecisionByCandidate.get(record.candidate_id);
            const payload = (candidate.payload && typeof candidate.payload === 'object') ? candidate.payload : {};
            const baseAttribution = typeof payload.attribution === 'string'
              ? payload.attribution
              : typeof payload.image_attribution === 'string' ? payload.image_attribution : '';
            const provenance = `Discovery hub import: manifest ${row.id}, candidate ${record.candidate_key}, image decision ${record.image.decision_id}`;
            const image = await tx.beverage_images.create({
              data: {
                beverage_id: beer.id,
                source_type: decision?.image_source ?? candidate.source ?? '',
                source_url: candidate.image_page_url ?? candidate.source_url ?? '',
                storage_key: storageKeyByCandidate.get(record.candidate_id) as string,
                license_type: decision?.image_license ?? '',
                attribution: [baseAttribution, provenance].filter(Boolean).join(' | ').slice(0, 512),
                license_url: typeof payload.license_url === 'string' ? payload.license_url : '',
                status: 'approved',
                verified_at: now,
                source_content_type: fetchedByCandidate.get(record.candidate_id)?.contentType ?? decision?.image_content_type ?? null,
                source_checked_at: now,
                source_check_status: 'image',
              },
            });
            imageId = image.id;
            imagesInserted += 1;
          }
          await tx.discovery_candidates.update({
            where: { id: record.candidate_id },
            data: { review_status: 'imported', matched_beer_id: beer.id, updated_at: now },
          });
          assignments.push({
            candidate_id: record.candidate_id,
            candidate_key: record.candidate_key,
            beer_id: beer.id,
            brewery_id: breweryId,
            image_id: imageId,
          });
        }

        report = {
          manifest_id: row.id,
          sha256: row.sha256,
          dry_run: false,
          beers_inserted: assignments.length - imageOnlyTargetByRecord.size,
          breweries_inserted: createdBreweryId.size,
          images_inserted: imagesInserted,
          id_assignments: assignments,
        };
        await tx.discovery_import_manifests.update({
          where: { id: row.id },
          data: { status: 'imported', imported_at: now },
        });
        await tx.discovery_manifest_events.create({
          data: {
            manifest_id: row.id,
            action: 'import',
            from_status: 'approved',
            to_status: 'imported',
            note: JSON.stringify(report),
            actor_id: null,
            actor_uid: null,
          },
        });
      },
      { maxWait: 300000, timeout: 900000, isolationLevel: 'RepeatableRead' } as any,
    );
  } catch (e) {
    if (e instanceof DryRunRollback) {
      return report as unknown as ImportReport;
    }
    if (isSerializationFailure(e)) {
      throw refused(
        'stale',
        'a concurrent change (another import or a review decision) committed while this import was in flight; the transaction aborted with nothing written. Re-check the manifest and catalog state, then retry deliberately.',
      );
    }
    throw e;
  }
  return report as unknown as ImportReport;
};

const argValue = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const main = async () => {
  const args = process.argv.slice(2);
  const loaderUrl = process.env.DATABASE_URL_ADMIN_LOADER || '';
  if (!loaderUrl) {
    console.error('REFUSING TO IMPORT: DATABASE_URL_ADMIN_LOADER is not set (the operator/migration identity is required; the API roles cannot write the catalog).');
    process.exit(2);
  }
  const manifestId = argValue(args, '--manifest');
  const expectedSha256 = argValue(args, '--sha256');
  if (!manifestId || !expectedSha256) {
    console.error('Usage: import-discovery-manifest.ts --manifest <mf-...> --sha256 <64 hex> [--dry-run]');
    process.exit(2);
  }
  const prisma = new PrismaClient({ datasources: { db: { url: loaderUrl } } });
  try {
    // The S3 uploader is built from the operator environment (the
    // same ADMIN_IMAGE_BUCKET / ADMIN_IMAGE_REGION / AWS_REGION
    // names the API's presigned read path uses, but resolved under
    // THIS process's operator identity, which is the one that must
    // hold the PutObject policy). Null when unconfigured: runImport
    // then refuses only if the manifest actually carries images.
    const uploadImage = getDefaultDiscoveryUploader();
    const report = await runImport(
      prisma,
      { manifestId, expectedSha256, dryRun: args.includes('--dry-run') },
      { fetchImage: fetchImageRestricted, uploadImage: uploadImage ?? undefined },
    );
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    if (e instanceof ImportRefusedError) {
      console.error(`IMPORT REFUSED [${e.check}]: ${e.message}`);
      process.exit(1);
    }
    console.error('IMPORT FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
};

if (require.main === module) {
  main();
}
