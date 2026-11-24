// Live integration tests for the discovery image review flow
// against a real database and a local stub image origin. Skipped
// unless RUN_DB_TESTS=1. Expects the same environment as
// discoveryDecisions.integration.test.ts (viewer reads, reviewer
// writes, owner for seeding/assertions). The stub origin is a Node
// http server on 127.0.0.1; the fetcher is the REAL restricted
// fetcher, composed with test seams that resolve the origin host to
// loopback and waive the address block for this suite only (the
// production validator is covered by the SSRF battery in
// src/discoveryImageFetch.test.ts, including loopback literals).
// The image store is a real content-addressed store in a temp dir.
//
// The flow proven end to end: POST image-fetches fetches the stub
// origin's PNG through the real transport, stores the bytes, and
// records the fetches row AS the reviewer role; GET preview serves
// exactly those bytes with the security headers; POST image-decisions
// binds the decision to the recorded SHA-256 and projects the
// candidate state; a second decision on the same fetch is a 409 (the
// UNIQUE(fetch_id) guard); and tampering with the stored object
// turns a later decision into a 409 hash mismatch.
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

const run = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

const PNG = (() => {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(200, 16);
  buf.writeUInt32BE(100, 20);
  return buf;
})();
const PNG_SHA = sha256Hex(PNG);

run('discovery image review against local database and stub origin', () => {
  // Constructed lazily inside beforeAll: a PrismaClient built at
  // describe-body level would throw on the missing owner URL even
  // when the suite is skipped (RUN_DB_TESTS unset).
  let owner: PrismaClient;
  let adminId = 0;
  let batchId = 0;
  let candidateId = 0;
  let tamperCandidateId = 0;
  let app: any;
  let server: http.Server;
  let storeDir: string;
  let store: ReturnType<typeof createImageStore>;

  const auth = (req: request.Test) => req.set('Authorization', 'Bearer <redacted>');

  beforeAll(async () => {
    owner = new PrismaClient({
      datasources: { db: { url: process.env.DISCOVERY_TEST_OWNER_URL as string } },
    });
    const admin = await owner.users.findUnique({ where: { uid: 'integration-admin' } });
    if (!admin) throw new Error('seed user integration-admin missing (see test-discovery-roles.sh)');
    adminId = admin.id;

    server = http.createServer((req, res) => {
      if (req.url === '/ale.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(PNG);
      } else if (req.url === '/page.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>not an image</html>');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;

    const batch = await owner.discovery_batches.create({
      data: {
        slug: `images-it-${Date.now()}`,
        title: 'Image integration batch',
        source: 'integration',
        manifest: {},
        bundle_sha256: `im${Date.now()}`.padEnd(64, '1').slice(0, 64),
        candidates_sha256: 'b'.repeat(64),
        record_count: 2,
      },
    });
    batchId = batch.id;
    const mk = async (key: string, imageUrl: string) => owner.discovery_candidates.create({
      data: {
        batch_id: batchId,
        candidate_key: key,
        payload: {},
        name: key,
        brewery_name: 'Integration Brewing',
        source: 'integration',
        source_record_id: key,
        image_url: imageUrl,
        image_source: 'integration',
        image_license: 'CC0',
        normalized_name: key.toLowerCase(),
        normalized_brewery: 'integration brewing',
      },
    });
    candidateId = (await mk('it:image', `${origin}/ale.png`)).id;
    tamperCandidateId = (await mk('it:tamper', `${origin}/ale.png`)).id;

    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-images-it-'));
    store = createImageStore(storeDir);
    const fetchImage = createRestrictedFetcher({
      resolve: async () => ['127.0.0.1'],
      transport: defaultSeams.transport,
      blockedReason: () => null, // test-only: the stub origin is loopback by design
    });

    app = createApp({
      prisma: getPrisma(),
      writePrisma: null,
      discoveryWritePrisma: getDiscoveryWritePrisma(),
      presignGetUrl: null,
      discoveryImageServices: { fetchImage, store },
      verifyIdToken: async () => ({ uid: 'integration-admin', user_id: 'integration-admin', admin: true }),
      findUserByUid: async () => ({ id: adminId, uid: 'integration-admin', user_name: 'Integration Admin' }),
    });
  });

  afterAll(async () => {
    await owner.discovery_image_decisions.deleteMany({ where: { candidate_id: { in: [candidateId, tamperCandidateId] } } });
    await owner.discovery_candidates.updateMany({
      where: { id: { in: [candidateId, tamperCandidateId] } },
      data: { image_decision_fetch_id: null },
    });
    await owner.discovery_image_fetches.deleteMany({ where: { candidate_id: { in: [candidateId, tamperCandidateId] } } });
    await owner.discovery_candidates.deleteMany({ where: { batch_id: batchId } });
    await owner.discovery_batches.deleteMany({ where: { id: batchId } });
    await owner.$disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it('fetches through the real transport, previews the stored bytes, and binds a decision to the hash', async () => {
    const fetched = await auth(request(app).post(`/admin-api/v1/discovery/candidates/${candidateId}/image-fetches`)).send({});
    expect(fetched.status).toBe(201);
    expect(fetched.body.outcome).toBe('success');
    expect(fetched.body.sha256).toBe(PNG_SHA);
    expect(fetched.body.width).toBe(200);
    expect(fetched.body.height).toBe(100);
    const fetchId = fetched.body.id as number;

    const storedRow = await owner.discovery_image_fetches.findUnique({ where: { id: fetchId } });
    expect(storedRow?.fetched_by).toBe(adminId);
    expect(storedRow?.fetched_by_uid).toBe('integration-admin');

    const preview = await auth(request(app).get(`/admin-api/v1/discovery/image-fetches/${fetchId}/preview`));
    expect(preview.status).toBe(200);
    expect(preview.headers['x-content-type-options']).toBe('nosniff');
    expect(preview.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(preview.body).equals(PNG)).toBe(true);

    const decided = await auth(request(app).post(`/admin-api/v1/discovery/candidates/${candidateId}/image-decisions`))
      .send({ fetch_id: fetchId, decision: 'approved', image_sha256: PNG_SHA });
    expect(decided.status).toBe(201);
    expect(decided.body.image_sha256).toBe(PNG_SHA);
    expect(JSON.stringify(decided.body)).not.toContain('integration-admin');

    const candidate = await owner.discovery_candidates.findUnique({ where: { id: candidateId } });
    expect(candidate?.image_decision).toBe('approved');
    expect(candidate?.image_decision_fetch_id).toBe(fetchId);
    const audit = await owner.discovery_image_decisions.findMany({ where: { candidate_id: candidateId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ fetch_id: fetchId, decision: 'approved', image_sha256: PNG_SHA, decided_by: adminId });
    expect(audit[0].decided_by_uid).toBe('integration-admin');

    const again = await auth(request(app).post(`/admin-api/v1/discovery/candidates/${candidateId}/image-decisions`))
      .send({ fetch_id: fetchId, decision: 'rejected' });
    expect(again.status).toBe(409);
  });

  it('refuses a decision when the stored bytes were tampered with (hash mismatch)', async () => {
    const fetched = await auth(request(app).post(`/admin-api/v1/discovery/candidates/${tamperCandidateId}/image-fetches`)).send({});
    expect(fetched.status).toBe(201);
    const fetchId = fetched.body.id as number;
    fs.writeFileSync(store.objectPath(PNG_SHA), Buffer.from('tampered bytes'));
    const decided = await auth(request(app).post(`/admin-api/v1/discovery/candidates/${tamperCandidateId}/image-decisions`))
      .send({ fetch_id: fetchId, decision: 'approved' });
    expect(decided.status).toBe(409);
    const audit = await owner.discovery_image_decisions.findMany({ where: { candidate_id: tamperCandidateId } });
    expect(audit).toHaveLength(0);
  });

  it('records a not_image fetch outcome for a non-image origin response', async () => {
    const other = await owner.discovery_candidates.create({
      data: {
        batch_id: batchId,
        candidate_key: 'it:html',
        payload: {},
        name: 'it:html',
        source: 'integration',
        source_record_id: 'it:html',
        image_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/page.html`,
        normalized_name: 'it:html',
      },
    });
    const fetched = await auth(request(app).post(`/admin-api/v1/discovery/candidates/${other.id}/image-fetches`)).send({});
    expect(fetched.status).toBe(201);
    expect(fetched.body.outcome).toBe('not_image');
    await owner.discovery_image_fetches.deleteMany({ where: { candidate_id: other.id } });
    await owner.discovery_candidates.delete({ where: { id: other.id } });
  });
});
