// Operator tool: load staged image candidates into beverage_images as
// PENDING rows for the admin approval queue (see docs/DEPLOYMENT_RUNBOOK.md,
// "Image approval workflow"). This is the import path for candidates
// whose beverage ALREADY exists in the catalog. Candidates that belong
// to a staged catalog batch (batch 2, the discovery batches) are NOT
// loaded by this script: their beverage rows do not exist yet, so their
// image rows arrive with that batch's own import, carrying the same
// provenance fields and source-check results.
//
// Connection: DATABASE_URL_ADMIN_LOADER, the operator/migration
// identity for the target database. Never either of the API's runtime
// roles: the viewer is SELECT-only, and the approver can write only
// decision columns and audit events, not new candidate rows. This
// script is run by a human operator against an approved target only;
// it is never run by the API and never on a schedule.
//
// Input: a JSON file holding an array of candidates:
//   {
//     "beverage_id": 3951,                       // required, existing beer id
//     "image_url": "https://.../direct.jpg",     // hosted candidate, OR
//     "storage_key": "beers/3951.jpg",           // private candidate (bare key)
//     "source_type": "openfoodfacts",            // required
//     "source_url": "https://.../product-page",  // required: provenance PAGE
//     "license_type": "CC BY-SA",                // optional, default ""
//     "attribution": "...",                      // optional, default ""
//     "license_url": "https://..."               // optional, default ""
//   }
//
// For hosted (image_url) candidates the script verifies the URL before
// inserting, so a source WEB PAGE is never mistaken for a direct image
// URL: it issues a HEAD request (falling back to a ranged GET when HEAD
// is refused or uninformative), follows redirects, and records
// source_content_type, source_checked_at, and source_check_status:
//   'image'       final Content-Type starts with image/
//   'not_image'   the URL answered with a non-image content type
//   'unreachable' network error or an HTTP failure status
// The URL itself is stored in storage_key (the hosted-image convention:
// an http(s) storage_key IS the direct image locator). Private
// (storage_key) candidates are inserted with source_check_status
// 'unchecked': there is nothing to fetch, and the reviewer previews the
// object through the API's presigned preview endpoint instead.
//
// Duplicates are skipped: a candidate whose beverage_id + storage_key
// already exists in beverage_images in ANY status is not re-inserted
// (a rejected candidate stays rejected; re-deciding it is a human act).
//
// Usage:
//   DATABASE_URL_ADMIN_LOADER=postgresql://... \
//     npx ts-node --transpile-only scripts/load-image-candidates.ts [--dry-run] candidates.json
//
// --dry-run (accepted before or after the file argument) performs the
// full fetch verification and dedupe classification and prints the
// same counts report, but inserts NOTHING: every write goes through
// the single guarded write helper in runLoader, which returns without
// touching the database when dry-run is on. The operator-reviewed load
// procedure in docs/DEPLOYMENT_RUNBOOK.md requires a reviewed dry run
// on the identical input file before the real run.
//
// Prints a JSON summary: { total, inserted, skipped_duplicate, invalid,
// not_image, unreachable } where not_image / unreachable count the
// hosted candidates among the inserted rows (they are inserted as
// pending so the audit trail shows why they cannot be approved; the
// API refuses to approve them with 422). In dry-run mode "inserted"
// counts the rows that WOULD be inserted by a real run on the same
// input against the same database state.
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';

export type Candidate = {
  beverage_id: number;
  image_url?: string;
  storage_key?: string;
  source_type: string;
  source_url: string;
  license_type?: string;
  attribution?: string;
  license_url?: string;
};

export type CheckResult = {
  status: 'image' | 'not_image' | 'unreachable';
  contentType: string | null;
};

export type CandidateInsert = {
  beverage_id: number;
  source_type: string;
  source_url: string;
  storage_key: string;
  license_type: string;
  attribution: string;
  license_url: string;
  status: string;
  source_content_type: string | null;
  source_checked_at: Date | null;
  source_check_status: string;
};

export type LoaderSummary = {
  total: number;
  inserted: number;
  skipped_duplicate: number;
  invalid: number;
  not_image: number;
  unreachable: number;
};

// Everything runLoader needs from the outside world. Production wires
// these to Prisma and the real URL check; tests wire mocks, so the
// classification logic runs with no database and no network.
export type LoaderDeps = {
  findExisting: (
    beverageId: number,
    storageKey: string,
  ) => Promise<{ id: number } | null>;
  insertCandidate: (data: CandidateInsert) => Promise<void>;
  checkImageUrl: (url: string) => Promise<CheckResult>;
};

const isHttpUrl = (value: unknown): value is string =>
  typeof value === 'string' &&
  (value.startsWith('https://') || value.startsWith('http://'));

export const checkImageUrl = async (url: string): Promise<CheckResult> => {
  const fetchFn = (globalThis as any).fetch as typeof fetch | undefined;
  if (!fetchFn) return { status: 'unreachable', contentType: null };
  try {
    let res = await fetchFn(url, { method: 'HEAD', redirect: 'follow' });
    const headType = res.headers.get('content-type');
    if (res.status === 405 || res.status === 501 || !headType) {
      res = await fetchFn(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-1023' },
        redirect: 'follow',
      });
    }
    const contentType = res.headers.get('content-type');
    if (!res.ok && res.status !== 206) {
      return { status: 'unreachable', contentType };
    }
    const isImage = !!contentType && contentType.toLowerCase().startsWith('image/');
    return { status: isImage ? 'image' : 'not_image', contentType };
  } catch {
    return { status: 'unreachable', contentType: null };
  }
};

export const validate = (raw: any): Candidate | null => {
  if (!raw || typeof raw !== 'object') return null;
  if (!Number.isInteger(raw.beverage_id) || raw.beverage_id < 1) return null;
  if (typeof raw.source_type !== 'string' || !raw.source_type) return null;
  if (typeof raw.source_url !== 'string' || !raw.source_url) return null;
  const hasUrl = isHttpUrl(raw.image_url);
  const hasKey =
    typeof raw.storage_key === 'string' &&
    raw.storage_key.length > 0 &&
    !isHttpUrl(raw.storage_key);
  if (hasUrl === hasKey) return null; // exactly one of the two locators
  return raw as Candidate;
};

export const runLoader = async (
  parsed: unknown[],
  deps: LoaderDeps,
  options: { dryRun?: boolean } = {},
): Promise<LoaderSummary> => {
  const dryRun = options.dryRun === true;
  const summary: LoaderSummary = {
    total: parsed.length,
    inserted: 0,
    skipped_duplicate: 0,
    invalid: 0,
    not_image: 0,
    unreachable: 0,
  };

  // The ONLY write path in the loader. In dry-run mode it returns
  // without touching the database, so a dry run provably inserts
  // nothing while the classification and counts proceed identically.
  const writeCandidate = async (data: CandidateInsert): Promise<void> => {
    if (dryRun) return;
    await deps.insertCandidate(data);
  };

  for (const raw of parsed) {
    const candidate = validate(raw);
    if (!candidate) {
      summary.invalid += 1;
      continue;
    }
    const storageKey = isHttpUrl(candidate.image_url)
      ? (candidate.image_url as string)
      : (candidate.storage_key as string);

    const existing = await deps.findExisting(candidate.beverage_id, storageKey);
    if (existing) {
      summary.skipped_duplicate += 1;
      continue;
    }

    let checkStatus: string = 'unchecked';
    let contentType: string | null = null;
    let checkedAt: Date | null = null;
    if (isHttpUrl(candidate.image_url)) {
      const check = await deps.checkImageUrl(candidate.image_url);
      checkStatus = check.status;
      contentType = check.contentType;
      checkedAt = new Date();
      if (check.status === 'not_image') summary.not_image += 1;
      if (check.status === 'unreachable') summary.unreachable += 1;
    }

    await writeCandidate({
      beverage_id: candidate.beverage_id,
      source_type: candidate.source_type,
      source_url: candidate.source_url,
      storage_key: storageKey,
      license_type: candidate.license_type || '',
      attribution: candidate.attribution || '',
      license_url: candidate.license_url || '',
      status: 'pending',
      source_content_type: contentType,
      source_checked_at: checkedAt,
      source_check_status: checkStatus,
    });
    summary.inserted += 1;
  }
  return summary;
};

const main = async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => a !== '--dry-run');
  if (!file) {
    console.error('Usage: load-image-candidates.ts [--dry-run] <candidates.json>');
    process.exit(2);
  }
  const loaderUrl = process.env.DATABASE_URL_ADMIN_LOADER || '';
  if (!loaderUrl) {
    console.error('REFUSING TO LOAD: DATABASE_URL_ADMIN_LOADER is not set (the operator/migration identity is required; the API roles cannot insert candidates).');
    process.exit(2);
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) {
    console.error('REFUSING TO LOAD: the candidates file must contain a JSON array.');
    process.exit(2);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: loaderUrl } } });
  try {
    const summary = await runLoader(
      parsed,
      {
        findExisting: (beverageId, storageKey) =>
          prisma.beverage_images.findFirst({
            where: { beverage_id: beverageId, storage_key: storageKey },
            select: { id: true },
          }),
        insertCandidate: async (data) => {
          await prisma.beverage_images.create({ data });
        },
        checkImageUrl,
      },
      { dryRun },
    );
    if (dryRun) {
      console.error('DRY RUN: no rows were inserted.');
    }
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
};

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
