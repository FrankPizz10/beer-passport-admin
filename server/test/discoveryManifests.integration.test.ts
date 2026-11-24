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
// abort, concurrent imports, and --dry-run.
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
    expect(candidates.length).toBe(25);
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  const fetchImage = () => seamFetchImage;

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
    const report = await runImport(
      loader,
      { manifestId: built.id, expectedSha256: built.sha256 },
      { fetchImage: fetchImage() },
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
      }
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
      runImport(loader, { manifestId: built.id, expectedSha256: built.sha256 }, { fetchImage: fetchImage() }),
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
      loader, { manifestId: built.id, expectedSha256: built.sha256 }, { fetchImage: fetchImage() },
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
      loader, { manifestId: built.id, expectedSha256: built.sha256 }, { fetchImage: fetchImage() },
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
      loader, { manifestId: built.id, expectedSha256: built.sha256 }, { fetchImage: fetchImage() },
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
      runImport(loader, { manifestId: built.id, expectedSha256: built.sha256 }, { fetchImage: fetchImage() }),
      runImport(loader, { manifestId: built.id, expectedSha256: built.sha256 }, { fetchImage: fetchImage() }),
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
    const report = await runImport(
      loader,
      { manifestId: built.id, expectedSha256: built.sha256, dryRun: true },
      { fetchImage: fetchImage() },
    );
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
});
