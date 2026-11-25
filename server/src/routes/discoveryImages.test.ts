// Discovery image review endpoints (POST/GET image-fetches, preview,
// image-decisions):
// - auth is the shared middleware: 401 without a token.
// - 503 when the discovery write path is not configured (null write
//   client) or the image store is unconfigured; browsing unaffected.
// - fetch: 404 unknown candidate; 422 when the candidate has no
//   fetchable http(s) image URL (absent, credentialed); 429 past the
//   per-reviewer rate limit; success and failure outcomes are both
//   recorded as fetches rows and returned with 201.
// - preview: serves the stored bytes with the verified content type
//   and the nosniff + CSP sandbox headers; 404 for failed fetches and
//   for objects missing from the store.
// - decision: vocabulary approved/rejected (issues/001); 404 for a
//   fetch of another candidate; 422 for a failed fetch; 409 for an
//   already-decided fetch, a supplied image_sha256 that differs, and
//   stored bytes that no longer hash to the recorded SHA-256
//   (tampered or missing); on success ONE transaction inserts the
//   audit row and projects the candidate state.
// - the Firebase UID is recorded on the audit rows but never appears
//   in any response payload.
// All Prisma dependencies are stubs; the image store is a real
// content-addressed store in a temp directory; the fetcher is a stub
// returning real PNG bytes.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createApp } from '../app';
import { createImageStore, ImageStore } from '../discoveryImageStore';
import { sha256Hex } from '../discoveryImageFetch';

const ADMIN_UID = 'admin-uid-secret';

const adminDeps = {
  verifyIdToken: jest.fn(async () => ({ uid: ADMIN_UID, user_id: ADMIN_UID, admin: true })),
  findUserByUid: jest.fn(async () => ({ id: 1, uid: ADMIN_UID, user_name: 'Admin One' })),
};

const pngBytes = (): Buffer => {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(640, 16);
  buf.writeUInt32BE(480, 20);
  return buf;
};
const PNG = pngBytes();
const PNG_SHA = sha256Hex(PNG);

const candidateRow = (overrides: Record<string, unknown> = {}) => ({
  id: 11,
  batch_id: 3,
  candidate_key: 'wikidata:Q123',
  name: 'Candidate Ale',
  image_url: 'https://images.example/ale.png',
  image_source: 'wikidata',
  image_license: 'CC BY-SA 4.0',
  image_decision: null,
  image_decision_fetch_id: null,
  image_decision_at: null,
  ...overrides,
});

const fetchRow = (overrides: Record<string, unknown> = {}) => ({
  id: 51,
  candidate_id: 11,
  image_ref: 'https://images.example/ale.png',
  sha256: PNG_SHA,
  content_type: 'image/png',
  byte_size: PNG.length,
  width: 640,
  height: 480,
  outcome: 'success',
  outcome_detail: null,
  fetched_by: 1,
  fetched_by_uid: ADMIN_UID,
  fetched_at: new Date('2026-11-23T12:00:00Z'),
  fetcher: { id: 1, user_name: 'Admin One' },
  decision: null,
  ...overrides,
});

interface Harness {
  app: any;
  store: ImageStore;
  storeDir: string;
  writeCreates: { fetches: any[]; decisions: any[] };
  candidateUpdates: any[];
  setFetchCount: (n: number) => void;
  setFetcherResult: (r: any) => void;
  addFetchRow: (row: any) => void;
  addDecisionRow: (row: any) => void;
}

const buildApp = (opts: {
  candidate?: any;
  writeConfigured?: boolean;
  storeConfigured?: boolean;
} = {}): Harness => {
  const candidate = opts.candidate === undefined ? candidateRow() : opts.candidate;
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-images-api-'));
  const store = createImageStore(opts.storeConfigured === false ? undefined : storeDir);
  const fetchRows: any[] = [];
  const decisionRows: any[] = [];
  let fetchCount = 0;
  let fetcherResult: any = {
    outcome: 'success',
    image: {
      bytes: PNG, sha256: PNG_SHA, contentType: 'image/png',
      width: 640, height: 480, finalUrl: 'https://images.example/ale.png', redirects: 0,
    },
  };
  const writeCreates = { fetches: [] as any[], decisions: [] as any[] };
  const candidateUpdates: any[] = [];

  const readPrisma = {
    discovery_candidates: {
      findUnique: jest.fn(async ({ where }: any) =>
        candidate && where.id === candidate.id ? candidate : null),
    },
    discovery_image_fetches: {
      // The rate limiter counts by fetcher + window; the list counts
      // by candidate. The stub distinguishes by the where shape.
      count: jest.fn(async ({ where }: any) =>
        where && (where.fetched_by !== undefined || where.fetched_by_uid !== undefined)
          ? fetchCount
          : fetchRows.length),
      findMany: jest.fn(async () => [...fetchRows].reverse()),
      findFirst: jest.fn(async ({ orderBy }: any) => {
        if (!fetchRows.length) return null;
        const sorted = [...fetchRows].sort(
          (a: any, b: any) => a.fetched_at.getTime() - b.fetched_at.getTime());
        return orderBy && orderBy.fetched_at === 'desc' ? sorted[sorted.length - 1] : sorted[0];
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        fetchRows.find((f) => f.id === where.id) ?? null),
    },
    discovery_image_decisions: {
      count: jest.fn(async () => decisionRows.length),
      findMany: jest.fn(async () => [...decisionRows].reverse()),
      findUnique: jest.fn(async ({ where }: any) =>
        decisionRows.find((d) => d.fetch_id === where.fetch_id) ?? null),
    },
  };

  const tx = {
    discovery_image_decisions: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: 71, decided_at: new Date('2026-11-23T12:30:00Z'), ...data };
        decisionRows.push(row);
        writeCreates.decisions.push(data);
        return row;
      }),
    },
    discovery_candidates: {
      updateMany: jest.fn(async (args: any) => {
        candidateUpdates.push(args);
        return { count: 1 };
      }),
    },
  };
  const writePrisma = opts.writeConfigured === false ? null : {
    discovery_image_fetches: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: 51 + fetchRows.length, fetched_at: new Date(), fetcher: { id: 1, user_name: 'Admin One' }, decision: null, ...data };
        fetchRows.push(row);
        writeCreates.fetches.push(data);
        return row;
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };

  const services = {
    fetchImage: jest.fn(async () => fetcherResult),
    store,
  };

  const app = createApp({
    prisma: readPrisma,
    writePrisma: null,
    discoveryWritePrisma: writePrisma,
    presignGetUrl: null,
    discoveryImageServices: services,
    ...adminDeps,
  });

  return {
    app, store, storeDir, writeCreates, candidateUpdates,
    setFetchCount: (n: number) => { fetchCount = n; },
    setFetcherResult: (r: any) => { fetcherResult = r; },
    addFetchRow: (row: any) => { fetchRows.push(row); },
    addDecisionRow: (row: any) => { decisionRows.push(row); },
  };
};

const auth = (req: request.Test) => req.set('Authorization', 'Bearer test-token');

describe('discovery image fetches', () => {
  it('requires auth', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/admin-api/v1/discovery/candidates/11/image-fetches').send({});
    expect(res.status).toBe(401);
  });

  it('answers 503 when the discovery write path is not configured', async () => {
    const { app } = buildApp({ writeConfigured: false });
    const res = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/image-fetches')).send({});
    expect(res.status).toBe(503);
  });

  it('answers 503 when the image store is not configured', async () => {
    const { app } = buildApp({ storeConfigured: false });
    const res = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/image-fetches')).send({});
    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/DISCOVERY_IMAGE_STORE/);
  });

  it('404s for an unknown candidate', async () => {
    const { app } = buildApp();
    const res = await auth(request(app).post('/admin-api/v1/discovery/candidates/999/image-fetches')).send({});
    expect(res.status).toBe(404);
  });

  it('422s when the candidate has no staged image URL', async () => {
    const { app } = buildApp({ candidate: candidateRow({ image_url: null }) });
    const res = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/image-fetches')).send({});
    expect(res.status).toBe(422);
  });

  it('422s when the staged image URL is credentialed', async () => {
    const { app } = buildApp({ candidate: candidateRow({ image_url: 'https://user:pass@images.example/ale.png' }) });
    const res = await auth(request(app).post('/admin-api/v1/discovery/candidates/11/image-fetches')).send({});
    expect(res.status).toBe(422);
  });

  it('fetches, stores, records, and returns the fetch on success', async () => {
    const h = buildApp();
    const res = await auth(request(h.app).post('/admin-api/v1/discovery/candidates/11/image-fetches')).send({});
    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('success');
    expect(res.body.sha256).toBe(PNG_SHA);
    expect(res.body.content_type).toBe('image/png');
    expect(res.body.width).toBe(640);
    expect(res.body.fetched_by).toEqual({ id: 1, user_name: 'Admin One' });
    expect(JSON.stringify(res.body)).not.toContain(ADMIN_UID);
    // The bytes are in the store under their hash.
    const stored = await h.store.get(PNG_SHA);
    expect(stored !== null && stored.equals(PNG)).toBe(true);
    // The fetches row was written through the write client with the UID audit field.
    expect(h.writeCreates.fetches).toHaveLength(1);
    expect(h.writeCreates.fetches[0]).toMatchObject({ candidate_id: 11, outcome: 'success', fetched_by_uid: ADMIN_UID });
  });

  it('records a failure outcome as a fetches row and returns it', async () => {
    const h = buildApp();
    h.setFetcherResult({ outcome: 'not_image', detail: "Final Content-Type 'text/html' is not image/*." });
    const res = await auth(request(h.app).post('/admin-api/v1/discovery/candidates/11/image-fetches')).send({});
    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('not_image');
    expect(res.body.sha256).toBeNull();
    expect(h.writeCreates.fetches[0]).toMatchObject({ outcome: 'not_image', sha256: null });
  });

  it('answers 429 past the per-reviewer rate limit', async () => {
    const h = buildApp();
    h.setFetchCount(30);
    const res = await auth(request(h.app).post('/admin-api/v1/discovery/candidates/11/image-fetches')).send({});
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('too_many_requests');
    // Machine-readable retry guidance rides along: with no readable
    // oldest row the stub yields the full-window fallback, mirrored
    // in the Retry-After header.
    expect(res.body.error.retry_after_seconds).toBe(3600);
    expect(res.headers['retry-after']).toBe('3600');
    expect(h.writeCreates.fetches).toHaveLength(0);
  });

  it('lists the candidate fetch history in the shared envelope', async () => {
    const h = buildApp();
    h.addFetchRow(fetchRow());
    const res = await auth(request(h.app).get('/admin-api/v1/discovery/candidates/11/image-fetches'));
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].id).toBe(51);
    expect(res.body.pagination.total_results).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain(ADMIN_UID);
  });
});

describe('discovery image preview', () => {
  it('serves the stored bytes with the verified type and security headers', async () => {
    const h = buildApp();
    h.addFetchRow(fetchRow());
    await h.store.put(PNG);
    const res = await auth(request(h.app).get('/admin-api/v1/discovery/image-fetches/51/preview'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
  });

  it('404s for a failed fetch and for a missing stored object', async () => {
    const h = buildApp();
    h.addFetchRow(fetchRow({ id: 52, outcome: 'too_large', sha256: null }));
    const failed = await auth(request(h.app).get('/admin-api/v1/discovery/image-fetches/52/preview'));
    expect(failed.status).toBe(404);
    h.addFetchRow(fetchRow({ id: 53 }));
    const missing = await auth(request(h.app).get('/admin-api/v1/discovery/image-fetches/53/preview'));
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toMatch(/missing from the image store/);
  });
});

describe('discovery image decisions', () => {
  const decide = (app: any, body: any, candidateId = 11) =>
    auth(request(app).post(`/admin-api/v1/discovery/candidates/${candidateId}/image-decisions`)).send(body);

  it('answers 503 when the write path is not configured', async () => {
    const { app } = buildApp({ writeConfigured: false });
    const res = await decide(app, { fetch_id: 51, decision: 'approved' });
    expect(res.status).toBe(503);
  });

  it('validates the body (400)', async () => {
    const { app } = buildApp();
    expect((await decide(app, { decision: 'approved' })).status).toBe(400);
    expect((await decide(app, { fetch_id: 51, decision: 'maybe' })).status).toBe(400);
    expect((await decide(app, { fetch_id: 51, decision: 'approved', image_sha256: 'xyz' })).status).toBe(400);
  });

  it('404s when the fetch belongs to another candidate', async () => {
    const h = buildApp();
    h.addFetchRow(fetchRow({ candidate_id: 12 }));
    await h.store.put(PNG);
    const res = await decide(h.app, { fetch_id: 51, decision: 'approved' });
    expect(res.status).toBe(404);
  });

  it('422s when the fetch did not succeed', async () => {
    const h = buildApp();
    h.addFetchRow(fetchRow({ outcome: 'dns_blocked', sha256: null }));
    const res = await decide(h.app, { fetch_id: 51, decision: 'approved' });
    expect(res.status).toBe(422);
  });

  it('409s when the fetch is already decided', async () => {
    const h = buildApp();
    h.addFetchRow(fetchRow());
    h.addDecisionRow({ id: 71, candidate_id: 11, fetch_id: 51, decision: 'approved' });
    await h.store.put(PNG);
    const res = await decide(h.app, { fetch_id: 51, decision: 'rejected' });
    expect(res.status).toBe(409);
  });

  it('409s when the supplied image_sha256 does not match the fetch', async () => {
    const h = buildApp();
    h.addFetchRow(fetchRow());
    await h.store.put(PNG);
    const res = await decide(h.app, { fetch_id: 51, decision: 'approved', image_sha256: 'b'.repeat(64) });
    expect(res.status).toBe(409);
  });

  it('409s when the stored bytes were tampered with after the fetch', async () => {
    const h = buildApp();
    h.addFetchRow(fetchRow());
    await h.store.put(PNG);
    const objectPath = h.store.objectPath(PNG_SHA);
    fs.writeFileSync(objectPath, Buffer.from('tampered bytes'));
    const res = await decide(h.app, { fetch_id: 51, decision: 'approved' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/hash mismatch/);
    expect(h.writeCreates.decisions).toHaveLength(0);
  });

  it('409s when the stored object is missing', async () => {
    const h = buildApp();
    h.addFetchRow(fetchRow());
    const res = await decide(h.app, { fetch_id: 51, decision: 'approved' });
    expect(res.status).toBe(409);
    expect(h.writeCreates.decisions).toHaveLength(0);
  });

  it('records the decision and projects the candidate state in one transaction', async () => {
    const h = buildApp();
    h.addFetchRow(fetchRow());
    await h.store.put(PNG);
    const res = await decide(h.app, {
      fetch_id: 51, decision: 'approved', image_sha256: PNG_SHA, note: 'Label matches the product.',
    });
    expect(res.status).toBe(201);
    expect(res.body.decision).toBe('approved');
    expect(res.body.image_sha256).toBe(PNG_SHA);
    expect(res.body.fetch_id).toBe(51);
    expect(res.body.decided_by).toEqual({ id: 1, user_name: 'Admin One' });
    expect(JSON.stringify(res.body)).not.toContain(ADMIN_UID);
    expect(h.writeCreates.decisions).toHaveLength(1);
    expect(h.writeCreates.decisions[0]).toMatchObject({
      candidate_id: 11, fetch_id: 51, image_sha256: PNG_SHA,
      image_source: 'wikidata', image_license: 'CC BY-SA 4.0',
      decided_by_uid: ADMIN_UID,
    });
    expect(h.candidateUpdates).toHaveLength(1);
    expect(h.candidateUpdates[0].data).toMatchObject({
      image_decision: 'approved', image_decision_fetch_id: 51,
    });
  });

  it('lists the candidate image decision history', async () => {
    const h = buildApp();
    h.addFetchRow(fetchRow());
    await h.store.put(PNG);
    await decide(h.app, { fetch_id: 51, decision: 'rejected', note: 'Wrong product.' });
    const res = await auth(request(h.app).get('/admin-api/v1/discovery/candidates/11/image-decisions'));
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].decision).toBe('rejected');
    expect(JSON.stringify(res.body)).not.toContain(ADMIN_UID);
  });
});
