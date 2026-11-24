// Live rehearsal for discovery import manifests and the import
// executor against a disposable database (hub decision 006
// revisions 1 and 2, issues/001 section 4). Skipped unless
// RUN_DB_TESTS=1. Provisions come from
// server/scripts/test-discovery-manifests.sh: base catalog schema +
// migrations 001-005, viewer + reviewer roles, two admin users, and
// the Phase 2 seed bundle (25 records) already ingested with the
// operator loader identity.
//
// The suite drives candidates through the REAL Phase 3 decision
// endpoints and the REAL Phase 4 image flow (local stub origin, the
// Phase 4 suite's test seams), builds, approves, and exports a
// manifest through the API, then runs the REAL import executor
// (runImport, operator loader client, seam fetcher) inside the
// disposable database and verifies the catalog writes. The negative
// battery follows: draft refusal, fingerprint abort on a
// count-preserving rename, decision-change abort, tampered-image
// abort, concurrent imports, and --dry-run. Three import-safety
// regressions close the suite: sequences already ahead of the table
// maximum are never rewound, a sequence alignment failure aborts
// before any write, and a normal catalog write attempted mid-import
// is held off by the import's catalog table locks. The S3 storage
// scenarios run throughout via a stub uploader (never AWS): the
// positive import stores the content-addressed key and the stub
// receives exactly the verified bytes, --dry-run uploads nothing,
// and the suite ends with an uploader-failure abort and a
// no-uploader-configured refusal, both image_upload.
//
// Clients are constructed lazily inside beforeAll: a PrismaClient
// built at describe-body level would throw on a missing URL even
// when the suite is skipped.
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app';
import { getPrisma } from '../src/db';
import { getDiscoveryWritePrisma } from '../src/discoveryWriteDb';
import { createRestrictedFetcher, defaultSeams, sha256Hex } from '../src/discoveryImageFetch';
import { createImageStore } from '../src/discoveryImageStore';
import { ImportRefusedError, runImport } from '../scripts/import-discovery-manifest';
import { discoveryObjectKey } from '../src/discoveryImageUpload';
import { manifestSha256, payloadSha256 } from '../src/discoveryManifestCore';

const run = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(240000);

const PNG = (() => {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(200, 16);
  buf.writeUInt32BE(100, 20);
  return buf;
})();
const PNG2 = Buffer.from(PNG);
PNG2.writeUInt32BE(201, 16); // same format, different bytes, different hash
const PNG_SHA = sha256Hex(PNG);

const BATCH_SLUG = 'manifest-seed-25';
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

run('discovery manifests + import executor against the disposable database', () => {
  let owner: PrismaClient;
  let loader: PrismaClient;
  let app: any;
  let server: http.Server;
  let origin = '';
  let storeDir: string;
  let adminId = 0;
  let frankId = 0;
  let batchId = 0;
  let pool: any[] = [];
  let poolCursor = 0;
  let seamFetchImage: (url: string) => Promise<any>;
  const served = new Map<string, Buffer>();

  const asAdmin = (r: request.Test) => r.set('Authorization', 'Bearer admin-token');
  const asFrank = (r: request.Test) => r.set('Authorization', 'Bearer frank-token');

  const takeFromPool = (n: number): any[] => {
    const taken = pool.slice(poolCursor, poolCursor + n);
    if (taken.length < n) throw new Error(`candidate pool exhausted (wanted ${n})`);
    poolCursor += n;
    return taken;
  };

  const decide = async (candidateId: number, decision: string, extra: Record<string, unknown> = {}) => {
    const res = await asAdmin(request(app).post(`/admin-api/v1/discovery/candidates/${candidateId}/decide`))
      .send({ decision, ...extra });
    expect(res.status).toBe(200);
    return res.body;
  };

  const driveToSelected = async (candidate: any) => {
    const fresh = await owner.discovery_candidates.findUnique({ where: { id: candidate.id } });
    if (fresh?.review_status === 'held') await decide(candidate.id, 'unhold');
    await decide(candidate.id, 'select');
  };

  const approveImageViaStub = async (candidate: any, imgPath: string) => {
    await owner.discovery_candidates.update({
      where: { id: candidate.id },
      data: { image_url: `${origin}${imgPath}` },
    });
    const fetched = await asAdmin(request(app).post(`/admin-api/v1/discovery/candidates/${candidate.id}/image-fetches`)).send({});
    expect(fetched.status).toBe(201);
    expect(fetched.body.outcome).toBe('success');
    expect(fetched.body.sha256).toBe(PNG_SHA);
    const decided = await asAdmin(request(app).post(`/admin-api/v1/discovery/candidates/${candidate.id}/image-decisions`))
      .send({ fetch_id: fetched.body.id, decision: 'approved', image_sha256: PNG_SHA });
    expect(decided.status).toBe(201);
    return decided.body;
  };

  const buildManifest = async () => {
    const res = await asAdmin(request(app).post(`/admin-api/v1/discovery/batches/${batchId}/manifests`)).send({});
    expect(res.status).toBe(201);
    return res.body;
  };

  const approveManifest = async (manifest: any) => {
    const res = await asFrank(request(app).post(`/admin-api/v1/discovery/manifests/${manifest.id}/approve`))
      .send({ sha256: manifest.sha256 });
    expect(res.status).toBe(200);
    return res.body;
  };

  const manifestDetail = async (id: string) => {
    const res = await asAdmin(request(app).get(`/admin-api/v1/discovery/manifests/${id}`));
    expect(res.status).toBe(200);
    return res.body;
  };

  const beerCount = async () => owner.beers.count();
  const imageCount = async () => owner.beverage_images.count();

  // Test scaffolding cleanup in a disposable database: void the
  // manifest through the API, and move leftover selected candidates
  // out of 'selected' with a direct owner update so the next
  // scenario's build (which covers ALL selected candidates of the
  // batch) starts from a clean slate. The audit rows stay.
  const cleanupScenario = async (manifestId: string | null, candidateIds: number[]) => {
    if (manifestId) {
      await asAdmin(request(app).post(`/admin-api/v1/discovery/manifests/${manifestId}/void`)).send({});
    }
    for (const id of candidateIds) {
      const c = await owner.discovery_candidates.findUnique({ where: { id } });
      if (c?.review_status === 'selected') {
        await owner.discovery_candidates.update({
          where: { id },
          data: { review_status: 'rejected' },
        });
      }
    }
  };

  beforeAll(async () => {
    owner = new PrismaClient({
      datasources: { db: { url: process.env.DISCOVERY_TEST_OWNER_URL as string } },
    });
    loader = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL_ADMIN_LOADER as string } },
    });
    const admin = await owner.users.findUnique({ where: { uid: 'integration-admin' } });
    const frank = await owner.users.findUnique({ where: { uid: 'integration-frank' } });
    if (!admin || !frank) throw new Error('seed users missing (see test-discovery-manifests.sh)');
    adminId = admin.id;
    frankId = frank.id;

    server = http.createServer((req, res) => {
      const bytes = served.get(req.url || '') ?? (req.url?.startsWith('/img/') ? PNG : null);
      if (bytes) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(bytes);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Seeded live catalog: two beers with fixed ids (max id 102, so
    // imported ids must land above it), a seed brewery, the Sierra
    // Nevada brewery one seed candidate names (so it resolves as an
    // existing brewery), and one style per style name the pool uses.
    const seedBrewery = await owner.breweries.create({ data: { name: 'Seed Brewing Co', descript: '' } });
    await owner.breweries.create({ data: { name: 'Sierra Nevada', descript: '' } });
    await owner.beers.create({
      data: { id: 101, name: 'Seed Lager One', brewery_id: seedBrewery.id, upc: '999000111222', descript: '' },
    });
    await owner.beers.create({
      data: { id: 102, name: 'Seed Lager Two', brewery_id: seedBrewery.id, upc: '999000111333', descript: '' },
    });

    const batch = await owner.discovery_batches.findUnique({ where: { slug: BATCH_SLUG } });
    if (!batch) throw new Error(`seed batch ${BATCH_SLUG} missing (harness ingest did not run)`);
    batchId = batch.id;
    const candidates = await owner.discovery_candidates.findMany({
      where: { batch_id: batchId },
      orderBy: { candidate_key: 'asc' },
    });
    expect(candidates.length).toBe(Number(process.env.REVIEW_TEST_SEED_COUNT || 25));
    const pairs = await owner.discovery_candidate_pairs.findMany({
      where: { batch_id: batchId, status: 'pending' },
    });
    const pairInvolved = new Set<number>();
    for (const p of pairs) {
      pairInvolved.add(p.candidate_id);
      if (p.candidate_id_b) pairInvolved.add(p.candidate_id_b);
    }
    pool = candidates.filter(
      (c: any) => typeof c.brewery_name === 'string' && c.brewery_name.trim() !== '' && !pairInvolved.has(c.id),
    );
    if (pool.length < 10) throw new Error(`candidate pool too small: ${pool.length}`);

    const category = await owner.categories.create({ data: { cat_name: 'Integration Category' } });
    const styleNames = [...new Set(pool.map((c: any) => c.style).filter(Boolean))] as string[];
    for (const styleName of styleNames) {
      const existing = await owner.styles.findFirst({ where: { style_name: styleName } });
      if (!existing) await owner.styles.create({ data: { style_name: styleName, cat_id: category.id } });
    }

    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-manifests-it-'));
    const store = createImageStore(storeDir);
    seamFetchImage = createRestrictedFetcher({
      resolve: async () => ['127.0.0.1'],
      transport: defaultSeams.transport,
      blockedReason: () => null, // test-only: the stub origin is loopback by design
    });

    app = createApp({
      prisma: getPrisma(),
      writePrisma: null,
      discoveryWritePrisma: getDiscoveryWritePrisma(),
      presignGetUrl: null,
      discoveryImageServices: { fetchImage: seamFetchImage, store },
      discoveryManifestApproverIds: [frankId],
      verifyIdToken: async (token: string) => {
        const uid = token === 'frank-token' ? 'integration-frank' : 'integration-admin';
        return { uid, user_id: uid, admin: true };
      },
      findUserByUid: async (uid: string) =>
        uid === 'integration-frank'
          ? { id: frankId, uid, user_name: 'Integration Frank' }
          : { id: adminId, uid, user_name: 'Integration Admin' },
    });

  });

  afterAll(async () => {
    await owner.$disconnect();
    await loader.$disconnect();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true });
  });

  const fetchImage = () => seamFetchImage;

  // Stub S3 uploader: records every call (bytes copied) and returns
  // the real content-addressed key derivation, so scenarios can
  // assert the executor uploaded exactly the verified bytes and
  // stored the key. No AWS anywhere near this suite.
  const uploadCalls: Array<{ bytes: Buffer; sha256: string; contentType: string }> = [];
  const stubUploadImage = async (image: { bytes: Buffer; sha256: string; contentType: string }) => {
    uploadCalls.push({
      bytes: Buffer.from(image.bytes),
      sha256: image.sha256,
      contentType: image.contentType,
    });
    return discoveryObjectKey(image.sha256);
  };
  const importDeps = () => ({ fetchImage: fetchImage(), uploadImage: stubUploadImage });
  const expectedStorageKey = `discovery/${PNG_SHA.slice(0, 2)}/${PNG_SHA}`;

  // Pool access for the late scenarios: the shared cursor can run
  // dry (the positive scenario's no-image scan skips ahead), so fall
  // back to any pool candidate still pending and untouched.
  const takeCandidate = async (): Promise<any> => {
    try {
      return takeFromPool(1)[0];
    } catch {
      for (const c of pool) {
        const fresh = await owner.discovery_candidates.findUnique({ where: { id: c.id } });
        if (fresh?.review_status === 'pending') return fresh;
      }
      throw new Error('no unused candidate available');
    }
  };

  it('positive: build, approve, export, and import a manifest end to end', async () => {
    const withImages = takeFromPool(2);
    // The no-image record: a pool candidate with no staged image URL
    // (the seed bundle has one); if it was pair-involved, fall back
    // to clearing another pool candidate's image URL instead.
    let noImage: any = null;
    for (let i = poolCursor; i < pool.length; i += 1) {
      if (!pool[i].image_url) {
        noImage = pool[i];
        poolCursor = i + 1;
        break;
      }
    }
    if (!noImage) {
      noImage = takeFromPool(1)[0];
      await owner.discovery_candidates.update({
        where: { id: noImage.id },
        data: { image_url: null },
      });
    }
    const chosen = [...withImages, noImage];

    for (const c of withImages) {
      await driveToSelected(c);
      await approveImageViaStub(c, `/img/pool-${c.id}.png`);
    }
    await driveToSelected(noImage);

    const built = await buildManifest();
    expect(built.status).toBe('draft');
    expect(built.record_count).toBe(3);
    expect(built.can_approve).toBe(false);

    const detail = await manifestDetail(built.id);
    expect(detail.records.map((r: any) => r.candidate_id).sort((a: number, b: number) => a - b))
      .toEqual(chosen.map((c: any) => c.id).sort((a: number, b: number) => a - b));
    const imageRecords = detail.records.filter((r: any) => r.image);
    expect(imageRecords).toHaveLength(2);
    for (const r of imageRecords) expect(r.image.sha256).toBe(PNG_SHA);

    // The gate, against the real roles: a non-allowlisted admin gets
    // 403, a wrong hash from the approver gets 422, then the exact
    // hash approves.
    const forbidden = await asAdmin(request(app).post(`/admin-api/v1/discovery/manifests/${built.id}/approve`))
      .send({ sha256: built.sha256 });
    expect(forbidden.status).toBe(403);
    const wrongHash = await asFrank(request(app).post(`/admin-api/v1/discovery/manifests/${built.id}/approve`))
      .send({ sha256: 'cd'.repeat(32) });
    expect(wrongHash.status).toBe(422);
    const approved = await approveManifest(built);
    expect(approved.status).toBe('approved');
    expect(approved.approved_sha256).toBe(built.sha256);
    expect(approved.approved_by).toEqual({ id: frankId, user_name: 'Integration Frank' });

    // Export: the body bytes hash to the recorded sha256 (the
    // harness re-verifies offline with sha256sum).
    const exported = await asAdmin(request(app).get(`/admin-api/v1/discovery/manifests/${built.id}/export`));
    expect(exported.status).toBe(200);
    expect(exported.headers['x-manifest-sha256']).toBe(built.sha256);
    const exportText = (exported as any).text as string;
    expect(sha256Hex(Buffer.from(exportText, 'utf8'))).toBe(built.sha256);
    const exportDir = process.env.MANIFEST_EXPORT_DIR;
    if (exportDir) {
      fs.writeFileSync(path.join(exportDir, 'manifest.json'), exportText);
      fs.writeFileSync(path.join(exportDir, 'manifest.sha256'), built.sha256);
    }

    const beersBefore = await beerCount();
    const imagesBefore = await imageCount();
    uploadCalls.length = 0;
    const report = await runImport(
      loader,
      { manifestId: built.id, expectedSha256: built.sha256 },
      importDeps(),
    );
    expect(report.dry_run).toBe(false);
    expect(report.beers_inserted).toBe(3);
    expect(report.images_inserted).toBe(2);
    const expectedNewBreweries = new Set(
      detail.records
        .filter((r: any) => r.brewery?.mode === 'new')
        .map((r: any) => normalize(r.brewery_name || '')),
    ).size;
    expect(report.breweries_inserted).toBe(expectedNewBreweries);
    expect(await beerCount()).toBe(beersBefore + 3);
    expect(await imageCount()).toBe(imagesBefore + 2);

    // Id assignments: manifest order (candidate_key order), all
    // above the seeded max beer id 102, strictly increasing.
    const recordOrder = detail.records.map((r: any) => r.candidate_id);
    expect(report.id_assignments.map((a) => a.candidate_id)).toEqual(recordOrder);
    const beerIds = report.id_assignments.map((a) => a.beer_id);
    for (const id of beerIds) expect(id).toBeGreaterThan(102);
    expect([...beerIds].sort((a, b) => a - b)).toEqual(beerIds);

    for (const assignment of report.id_assignments) {
      const beer = await owner.beers.findUnique({ where: { id: assignment.beer_id } });
      expect(beer).not.toBeNull();
      expect(beer?.brewery_id).toBe(assignment.brewery_id);
      const candidate = await owner.discovery_candidates.findUnique({
        where: { id: assignment.candidate_id },
      });
      expect(candidate?.review_status).toBe('imported');
      expect(candidate?.matched_beer_id).toBe(assignment.beer_id);
      if (assignment.image_id !== null) {
        const image = await owner.beverage_images.findUnique({ where: { id: assignment.image_id } });
        expect(image?.status).toBe('approved');
        expect(image?.verified_at).not.toBeNull();
        expect(image?.beverage_id).toBe(assignment.beer_id);
        expect(image?.attribution).toContain(`manifest ${built.id}`);
        expect(image?.attribution).toContain('image decision');
        // The S3 gap, closed: storage_key is the content-addressed
        // object key (the bare key the presigned read path
        // resolves), NOT the source URL; source_url still carries
        // the origin.
        expect(image?.storage_key).toBe(expectedStorageKey);
        expect(image?.source_url).not.toBe(expectedStorageKey);
      }
    }

    // The uploader received exactly the verified bytes, once per
    // image record: same length, same hash, verified content type.
    expect(uploadCalls).toHaveLength(2);
    for (const call of uploadCalls) {
      expect(call.sha256).toBe(PNG_SHA);
      expect(call.contentType).toBe('image/png');
      expect(call.bytes.length).toBe(PNG.length);
      expect(sha256Hex(call.bytes)).toBe(PNG_SHA);
    }

    const stored = await owner.discovery_import_manifests.findUnique({ where: { id: built.id } });
    expect(stored?.status).toBe('imported');
    expect(stored?.imported_at).not.toBeNull();
    const events = await owner.discovery_manifest_events.findMany({
      where: { manifest_id: built.id },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual(['build', 'approve', 'import']);
  });

  it('negative 1: importing a draft manifest is refused before any write', async () => {
    const [candidate] = takeFromPool(1);
    await driveToSelected(candidate);
    await approveImageViaStub(candidate, `/img/draft-${candidate.id}.png`);
    const built = await buildManifest();
    const beersBefore = await beerCount();
    await expect(
      runImport(loader, { manifestId: built.id, expectedSha256: built.sha256 }, importDeps()),
    ).rejects.toMatchObject({ check: 'check1' });
    expect(await beerCount()).toBe(beersBefore);
    const stored = await owner.discovery_import_manifests.findUnique({ where: { id: built.id } });
    expect(stored?.status).toBe('draft');
    await cleanupScenario(built.id, [candidate.id]);
  });

  it('negative 2: a count-preserving catalog rename after build aborts on check 5 (fingerprint)', async () => {
    const [candidate] = takeFromPool(1);
    await driveToSelected(candidate);
    await approveImageViaStub(candidate, `/img/fp-${candidate.id}.png`);
    const built = await buildManifest();
    await approveManifest(built);
    const seeded = await owner.beers.findUnique({ where: { id: 101 } });
    await owner.beers.update({ where: { id: 101 }, data: { name: 'Seed Lager One Renamed' } });
    const beersBefore = await beerCount();
    const failure = await runImport(
      loader, { manifestId: built.id, expectedSha256: built.sha256 }, importDeps(),
    ).catch((e) => e);
    expect(failure).toBeInstanceOf(ImportRefusedError);
    expect(failure.check).toBe('check5');
    expect(failure.message).toContain('fingerprint');
    expect(await beerCount()).toBe(beersBefore);
    const stored = await owner.discovery_import_manifests.findUnique({ where: { id: built.id } });
    expect(stored?.status).toBe('approved');
    await owner.beers.update({ where: { id: 101 }, data: { name: seeded?.name } });
    await cleanupScenario(built.id, [candidate.id]);
  });

  it('negative 3: a candidate decision changed after approval aborts on check 2', async () => {
    const [candidate] = takeFromPool(1);
    await driveToSelected(candidate);
    await approveImageViaStub(candidate, `/img/dec-${candidate.id}.png`);
    const built = await buildManifest();
    await approveManifest(built);
    const rejected = await asAdmin(request(app).post(`/admin-api/v1/discovery/candidates/${candidate.id}/decide`))
      .send({ decision: 'reject', reason: 'other', note: 'changed after manifest approval' });
    expect(rejected.status).toBe(200);
    const beersBefore = await beerCount();
    const failure = await runImport(
      loader, { manifestId: built.id, expectedSha256: built.sha256 }, importDeps(),
    ).catch((e) => e);
    expect(failure).toBeInstanceOf(ImportRefusedError);
    expect(failure.check).toBe('check2');
    expect(await beerCount()).toBe(beersBefore);
    await cleanupScenario(built.id, []);
  });

  it('negative 4: image bytes that changed after approval abort the import on re-hash', async () => {
    const [candidate] = takeFromPool(1);
    await driveToSelected(candidate);
    await approveImageViaStub(candidate, '/img/tamper.png');
    const built = await buildManifest();
    await approveManifest(built);
    served.set('/img/tamper.png', PNG2);
    const beersBefore = await beerCount();
    const imagesBefore = await imageCount();
    const failure = await runImport(
      loader, { manifestId: built.id, expectedSha256: built.sha256 }, importDeps(),
    ).catch((e) => e);
    served.delete('/img/tamper.png');
    expect(failure).toBeInstanceOf(ImportRefusedError);
    expect(failure.check).toBe('image_refetch');
    expect(await beerCount()).toBe(beersBefore);
    expect(await imageCount()).toBe(imagesBefore);
    const stored = await owner.discovery_import_manifests.findUnique({ where: { id: built.id } });
    expect(stored?.status).toBe('approved');
    await cleanupScenario(built.id, [candidate.id]);
  });

  it('negative 5: two concurrent imports of one manifest produce exactly one import', async () => {
    const chosen = takeFromPool(2);
    for (const c of chosen) {
      await driveToSelected(c);
      await approveImageViaStub(c, `/img/conc-${c.id}.png`);
    }
    const built = await buildManifest();
    await approveManifest(built);
    const beersBefore = await beerCount();
    const imagesBefore = await imageCount();
    const results = await Promise.allSettled([
      runImport(loader, { manifestId: built.id, expectedSha256: built.sha256 }, importDeps()),
      runImport(loader, { manifestId: built.id, expectedSha256: built.sha256 }, importDeps()),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejectedResults = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejectedResults).toHaveLength(1);
    const loserReason = (rejectedResults[0] as PromiseRejectedResult).reason;
    expect(loserReason).toBeInstanceOf(ImportRefusedError);
    // The loser aborts as stale: it either sees the winner's commit
    // (check 1 / check 2) or its REPEATABLE READ transaction dies on
    // the winner's row updates, which the executor maps to 'stale'.
    expect(['check1', 'check2', 'stale']).toContain(loserReason.check);
    expect(await beerCount()).toBe(beersBefore + 2);
    expect(await imageCount()).toBe(imagesBefore + 2);
    const stored = await owner.discovery_import_manifests.findUnique({ where: { id: built.id } });
    expect(stored?.status).toBe('imported');
  });

  it('negative 6: --dry-run passes all checks and writes nothing', async () => {
    const [candidate] = takeFromPool(1);
    await driveToSelected(candidate);
    await approveImageViaStub(candidate, `/img/dry-${candidate.id}.png`);
    const built = await buildManifest();
    await approveManifest(built);
    const beersBefore = await beerCount();
    const imagesBefore = await imageCount();
    const maxBeer = await owner.beers.aggregate({ _max: { id: true } });
    uploadCalls.length = 0;
    const report = await runImport(
      loader,
      { manifestId: built.id, expectedSha256: built.sha256, dryRun: true },
      importDeps(),
    );
    // A dry run performs NO upload: the bytes are re-fetched and
    // verified, but nothing is PUT to the bucket.
    expect(uploadCalls).toHaveLength(0);
    expect(report.dry_run).toBe(true);
    expect(report.beers_inserted).toBe(1);
    expect(report.images_inserted).toBe(1);
    expect(report.id_assignments[0].beer_id).toBe((maxBeer._max.id ?? 0) + 1);
    expect(await beerCount()).toBe(beersBefore);
    expect(await imageCount()).toBe(imagesBefore);
    const stored = await owner.discovery_import_manifests.findUnique({ where: { id: built.id } });
    expect(stored?.status).toBe('approved');
    const after = await owner.discovery_candidates.findUnique({ where: { id: candidate.id } });
    expect(after?.review_status).toBe('selected');
    await cleanupScenario(built.id, [candidate.id]);
  });

  it('regression: id sequences already ahead of the table maximum are never moved backwards', async () => {
    const [candidate] = takeFromPool(1);
    await driveToSelected(candidate);
    await approveImageViaStub(candidate, `/img/seq-${candidate.id}.png`);
    const built = await buildManifest();
    await approveManifest(built);
    const maxBeer = (await owner.beers.aggregate({ _max: { id: true } }))._max.id ?? 0;
    const maxBrewery = (await owner.breweries.aggregate({ _max: { id: true } }))._max.id ?? 0;
    const maxImage = (await owner.beverage_images.aggregate({ _max: { id: true } }))._max.id ?? 0;
    // Simulate ids reserved outside the tables (another tool, a
    // restored dump, explicit-id inserts): every catalog sequence
    // sits ahead of its table's maximum.
    await owner.$queryRawUnsafe(`SELECT setval('beers_id_seq', ${maxBeer + 1000}, true)`);
    await owner.$queryRawUnsafe(`SELECT setval('breweries_id_seq', ${maxBrewery + 500}, true)`);
    await owner.$queryRawUnsafe(`SELECT setval('beverage_images_id_seq', ${maxImage + 500}, true)`);
    const report = await runImport(
      loader, { manifestId: built.id, expectedSha256: built.sha256 }, importDeps(),
    );
    expect(report.beers_inserted).toBe(1);
    // The new ids come from the sequences, so they land ABOVE the
    // ahead positions, not back at max + 1: alignment did not rewind.
    expect(report.id_assignments[0].beer_id).toBeGreaterThan(maxBeer + 1000);
    expect(report.id_assignments[0].image_id).not.toBeNull();
    expect(report.id_assignments[0].image_id as number).toBeGreaterThan(maxImage + 500);
    const beerSeq = await owner.$queryRawUnsafe<Array<{ v: number }>>(
      'SELECT last_value::int AS v FROM beers_id_seq',
    );
    expect(beerSeq[0].v).toBeGreaterThanOrEqual(maxBeer + 1000);
    const brewerySeq = await owner.$queryRawUnsafe<Array<{ v: number }>>(
      'SELECT last_value::int AS v FROM breweries_id_seq',
    );
    expect(brewerySeq[0].v).toBeGreaterThanOrEqual(maxBrewery + 500);
  });

  it('regression: a sequence alignment failure aborts the import before any catalog write', async () => {
    const [candidate] = takeFromPool(1);
    await driveToSelected(candidate);
    await approveImageViaStub(candidate, `/img/align-${candidate.id}.png`);
    const built = await buildManifest();
    await approveManifest(built);
    const beersBefore = await beerCount();
    const breweriesBefore = await owner.breweries.count();
    // Break the beers sequence's NAME: the alignment step resolves
    // sequences by name, so its setval now has nothing to align and
    // must fail loudly. (The column default references the sequence
    // by OID, so inserts would still work if the failure were
    // swallowed - which is exactly what must not happen.)
    await owner.$executeRawUnsafe('ALTER SEQUENCE beers_id_seq RENAME TO beers_id_seq_broken');
    try {
      const failure = await runImport(
        loader, { manifestId: built.id, expectedSha256: built.sha256 }, importDeps(),
      ).catch((e) => e);
      expect(failure).toBeInstanceOf(ImportRefusedError);
      expect(failure.check).toBe('sequence_alignment');
      expect(failure.message).toContain('beers_id_seq');
      expect(await beerCount()).toBe(beersBefore);
      expect(await owner.breweries.count()).toBe(breweriesBefore);
      const stored = await owner.discovery_import_manifests.findUnique({ where: { id: built.id } });
      expect(stored?.status).toBe('approved');
    } finally {
      await owner.$executeRawUnsafe('ALTER SEQUENCE beers_id_seq_broken RENAME TO beers_id_seq');
    }
    await cleanupScenario(built.id, [candidate.id]);
  });

  it('regression: a normal catalog write cannot slip in during an import (it waits for the import transaction)', async () => {
    let candidate: any = null;
    try {
      [candidate] = takeFromPool(1);
    } catch {
      candidate = null;
    }
    if (!candidate) {
      // The shared pool cursor can run dry late in the suite (the
      // positive scenario's no-image scan skips ahead past unused
      // candidates). Fall back to any pool candidate that is still
      // pending and untouched.
      for (const c of pool) {
        const fresh = await owner.discovery_candidates.findUnique({ where: { id: c.id } });
        if (fresh?.review_status === 'pending') {
          candidate = fresh;
          break;
        }
      }
    }
    if (!candidate) throw new Error('no unused candidate available for the concurrency scenario');
    await driveToSelected(candidate);
    await approveImageViaStub(candidate, `/img/lock-${candidate.id}.png`);
    const built = await buildManifest();
    await approveManifest(built);
    const seedBrewery = await owner.breweries.findFirst({ where: { name: 'Seed Brewing Co' } });
    if (!seedBrewery) throw new Error('seed brewery missing');
    // Gate the import inside its transaction: the image re-fetch
    // runs after all five checks, with the catalog table locks held,
    // so once the gate trips the import is provably between its
    // checks and its writes.
    let fetchStarted!: () => void;
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const fetchRelease = new Promise<void>((resolve) => { releaseFetch = resolve; });
    let firstFetch = true;
    const gatedFetch = async (url: string) => {
      if (firstFetch) {
        firstFetch = false;
        fetchStarted();
        await fetchRelease;
      }
      return seamFetchImage(url);
    };
    const beersBefore = await beerCount();
    const importPromise = runImport(
      loader, { manifestId: built.id, expectedSha256: built.sha256 }, { fetchImage: gatedFetch, uploadImage: stubUploadImage },
    );
    await fetchGate;
    // A normal catalog write (a new beer under an existing brewery)
    // must not complete while the import holds its locks: given a
    // 1s lock timeout, the lock itself refuses it.
    const writeAttempt = await owner.$transaction(async (txc) => {
      await txc.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
      return txc.beers.create({
        data: { name: 'Concurrent Write Attempt Ale', brewery_id: seedBrewery.id, descript: '' },
      });
    }).catch((e: any) => e);
    expect(writeAttempt).toBeInstanceOf(Error);
    expect(String(writeAttempt.message)).toMatch(/lock timeout|55P03/i);
    expect(await owner.beers.findFirst({ where: { name: 'Concurrent Write Attempt Ale' } })).toBeNull();
    releaseFetch();
    const report = await importPromise;
    expect(report.beers_inserted).toBe(1);
    expect(await beerCount()).toBe(beersBefore + 1);
    // Exactly one beer carries the imported candidate's name: the
    // blocked write did not slip a duplicate in alongside the import.
    const imported = await owner.beers.findMany({ where: { name: candidate.name } });
    expect(imported).toHaveLength(1);
    // After the import commits, the same write succeeds at once: it
    // was the import's lock that held it, nothing else.
    const landed = await owner.beers.create({
      data: { name: 'Concurrent Write Attempt Ale', brewery_id: seedBrewery.id, descript: '' },
    });
    expect(landed.id).toBeGreaterThan(0);
    await owner.beers.delete({ where: { id: landed.id } });
  });

  it('s3: an uploader failure aborts the import with image_upload and writes no catalog rows', async () => {
    const candidate = await takeCandidate();
    await driveToSelected(candidate);
    await approveImageViaStub(candidate, `/img/s3fail-${candidate.id}.png`);
    const built = await buildManifest();
    await approveManifest(built);
    const beersBefore = await beerCount();
    const imagesBefore = await imageCount();
    const failingUploadImage = async () => {
      throw new Error('simulated S3 failure: AccessDenied');
    };
    const failure = await runImport(
      loader, { manifestId: built.id, expectedSha256: built.sha256 },
      { fetchImage: fetchImage(), uploadImage: failingUploadImage },
    ).catch((e) => e);
    expect(failure).toBeInstanceOf(ImportRefusedError);
    expect(failure.check).toBe('image_upload');
    expect(failure.message).toContain('upload failed');
    expect(await beerCount()).toBe(beersBefore);
    expect(await imageCount()).toBe(imagesBefore);
    const stored = await owner.discovery_import_manifests.findUnique({ where: { id: built.id } });
    expect(stored?.status).toBe('approved');
    const after = await owner.discovery_candidates.findUnique({ where: { id: candidate.id } });
    expect(after?.review_status).toBe('selected');
    await cleanupScenario(built.id, [candidate.id]);
  });

  it('imports an approved image onto an explicit existing beer without inserting a beer', async () => {
    const candidate = await takeCandidate();
    await approveImageViaStub(candidate, `/img/image-only-${candidate.id}.png`);
    const intent = await asAdmin(request(app).post(`/admin-api/v1/discovery/candidates/${candidate.id}/review-intent`))
      .send({ expected_revision: null, intent: { mode: 'image_only', target_beer_id: 101 } });
    expect(intent.status).toBe(201);
    await driveToSelected(candidate);
    const built = await buildManifest();
    await approveManifest(built);
    const beforeBeers = await beerCount();
    const beforeImages = await imageCount();
    const report = await runImport(loader, { manifestId: built.id, expectedSha256: built.sha256 }, importDeps());
    expect(report.beers_inserted).toBe(0);
    expect(report.images_inserted).toBe(1);
    expect(await beerCount()).toBe(beforeBeers);
    expect(await imageCount()).toBe(beforeImages + 1);
    const image = await owner.beverage_images.findUnique({ where: { id: report.id_assignments[0].image_id as number } });
    expect(image?.beverage_id).toBe(101);
    expect(image?.storage_key).toBe(expectedStorageKey);
  });

  it('imports explicitly reviewed beer fields and keeps the staged payload unchanged', async () => {
    const candidate = await takeCandidate();
    await owner.discovery_candidates.update({ where: { id: candidate.id }, data: { image_url: null } });
    const original = await owner.discovery_candidates.findUnique({ where: { id: candidate.id } });
    const beer = { name: `Reviewed Ale ${candidate.id}`, brewery_name: candidate.brewery_name,
      style: candidate.style ?? null, abv: 4.2, ibu: candidate.ibu ?? null, barcode: null, description: candidate.description ?? null };
    const intent = await asAdmin(request(app).post(`/admin-api/v1/discovery/candidates/${candidate.id}/review-intent`))
      .send({ expected_revision: null, intent: { mode: 'new_beer', beer } });
    expect(intent.status).toBe(201);
    const audit = await (owner as any).discovery_review_intents.findUnique({ where: { id: intent.body.id } });
    expect(audit.previous_intent.beer.name).toBe(original?.name);
    expect(audit.previous_intent.beer.abv).toBe(original?.abv);
    expect(audit.decided_by).toBe(adminId);
    await driveToSelected(candidate);
    const built = await buildManifest();
    await approveManifest(built);
    const report = await runImport(loader, { manifestId: built.id, expectedSha256: built.sha256 }, importDeps());
    expect(report.beers_inserted).toBe(1);
    const inserted = await owner.beers.findUnique({ where: { id: report.id_assignments[0].beer_id } });
    expect(inserted?.name).toBe(beer.name);
    expect(inserted?.abv).toBe(4.2);
    const after = await owner.discovery_candidates.findUnique({ where: { id: candidate.id } });
    expect(after?.payload).toEqual(original?.payload);
  });

  it('refuses to attach the same approved bytes to the same beer twice', async () => {
    const candidate = await takeCandidate();
    await approveImageViaStub(candidate, `/img/duplicate-image-${candidate.id}.png`);
    const intent = await asAdmin(request(app).post(`/admin-api/v1/discovery/candidates/${candidate.id}/review-intent`))
      .send({ expected_revision: null, intent: { mode: 'image_only', target_beer_id: 101 } });
    expect(intent.status).toBe(201);
    await driveToSelected(candidate);
    const built = await buildManifest();
    await approveManifest(built);
    const before = await imageCount();
    const failure = await runImport(loader, { manifestId: built.id, expectedSha256: built.sha256 }, importDeps()).catch((e) => e);
    expect(failure).toMatchObject({ check: 'check4' });
    expect(await imageCount()).toBe(before);
    await cleanupScenario(built.id, [candidate.id]);
  });

  it('refuses an import when its recorded review intent is no longer current', async () => {
    const candidate = await takeCandidate();
    await approveImageViaStub(candidate, `/img/stale-intent-${candidate.id}.png`);
    const intent = await asAdmin(request(app).post(`/admin-api/v1/discovery/candidates/${candidate.id}/review-intent`))
      .send({ expected_revision: null, intent: { mode: 'image_only', target_beer_id: 101 } });
    expect(intent.status).toBe(201);
    await driveToSelected(candidate);
    const built = await buildManifest();
    await approveManifest(built);
    const before = await imageCount();
    // Simulate a privileged out-of-band revision to prove the executor
    // refuses even when the selected status and manifest are unchanged.
    await (owner as any).discovery_review_intents.create({ data: {
      candidate_id: candidate.id, intent: { mode: 'image_only', target_beer_id: 102 },
      previous_intent: { mode: 'image_only', target_beer_id: 101 },
    } });
    const failure = await runImport(loader, { manifestId: built.id, expectedSha256: built.sha256 }, importDeps()).catch((e) => e);
    expect(failure).toMatchObject({ check: 'check2' });
    expect(await imageCount()).toBe(before);
    await cleanupScenario(built.id, [candidate.id]);
  });

  it('continues to import an approved version 1 manifest under version 1 rules', async () => {
    const candidate = await takeCandidate();
    await owner.discovery_candidates.update({ where: { id: candidate.id }, data: { image_url: null } });
    await driveToSelected(candidate);
    const built = await buildManifest();
    const row = await owner.discovery_import_manifests.findUnique({ where: { id: built.id } });
    const content = JSON.parse(JSON.stringify(row?.manifest));
    content.schema = 'discovery-import-manifest/1';
    for (const record of content.records) {
      const staged = await owner.discovery_candidates.findUnique({ where: { id: record.candidate_id } });
      record.payload_sha256 = payloadSha256(staged?.payload);
      delete record.kind;
      delete record.intent_revision_id;
      delete record.target_beer_id;
    }
    const sha256 = manifestSha256(content);
    await owner.discovery_import_manifests.update({ where: { id: built.id }, data: { manifest: content, sha256 } });
    await approveManifest({ ...built, sha256 });
    const report = await runImport(loader, { manifestId: built.id, expectedSha256: sha256 }, importDeps());
    expect(report.beers_inserted).toBe(1);
  });

  it('refuses when an as-staged beer field changes after approval', async () => {
    const candidate = await takeCandidate();
    await owner.discovery_candidates.update({ where: { id: candidate.id }, data: { image_url: null } });
    await driveToSelected(candidate);
    const built = await buildManifest();
    await approveManifest(built);
    await owner.discovery_candidates.update({ where: { id: candidate.id }, data: { name: 'Changed after approval' } });
    const before = await beerCount();
    const failure = await runImport(loader, { manifestId: built.id, expectedSha256: built.sha256 }, importDeps()).catch((e) => e);
    expect(failure).toMatchObject({ check: 'check2' });
    expect(await beerCount()).toBe(before);
    await cleanupScenario(built.id, [candidate.id]);
  });

  it('s3: a manifest with images but no configured uploader is refused (image_upload), nothing written', async () => {
    const candidate = await takeCandidate();
    await driveToSelected(candidate);
    await approveImageViaStub(candidate, `/img/s3cfg-${candidate.id}.png`);
    const built = await buildManifest();
    await approveManifest(built);
    const beersBefore = await beerCount();
    const imagesBefore = await imageCount();
    // Deliberately NO uploadImage in deps: the executor must refuse
    // rather than fall back to storing the source URL as storage_key.
    const failure = await runImport(
      loader, { manifestId: built.id, expectedSha256: built.sha256 },
      { fetchImage: fetchImage() },
    ).catch((e) => e);
    expect(failure).toBeInstanceOf(ImportRefusedError);
    expect(failure.check).toBe('image_upload');
    expect(failure.message).toContain('ADMIN_IMAGE_BUCKET');
    expect(await beerCount()).toBe(beersBefore);
    expect(await imageCount()).toBe(imagesBefore);
    const stored = await owner.discovery_import_manifests.findUnique({ where: { id: built.id } });
    expect(stored?.status).toBe('approved');
    await cleanupScenario(built.id, [candidate.id]);
  });
});
