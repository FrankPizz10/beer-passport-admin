// Discovery manifest endpoints (build, list, detail, export,
// approve, void):
// - auth is the shared middleware: 401 without a token.
// - build: 503 without the write path; 404 unknown batch; 422 when
//   the batch has no selected candidates and 422 with the blocking
//   candidate ids + reasons when any selected candidate is not
//   import-eligible (nothing is created either way); on success a
//   draft manifest + build event are written in one transaction and
//   the stored hash equals the canonical hash of the stored content.
// - approve: Frank's gate. 403 for a caller not on the allowlist and
//   403 when the allowlist is empty (fail closed); 400 for a
//   malformed sha256; 422 for a hash that differs from the stored
//   manifest; 409 when the manifest is not in draft status; 503
//   without the write path; on success the four approval fields and
//   the approve event are written atomically.
// - void: draft and approved manifests void with an audit event;
//   imported and void manifests are final (409).
// - export: the response body is byte-identical to the hashed
//   canonical content (sha256 of the body equals the stored hash).
// - no response ever contains a Firebase UID.
// All Prisma dependencies are in-memory stubs.
import request from 'supertest';
import { createApp } from '../app';
import { canonicalManifestBytes, manifestSha256, sha256Hex } from '../discoveryManifestCore';

const FRANK_UID = 'frank-uid-secret';
const ADMIN_UID = 'admin-uid-secret';
const FRANK_ID = 7;
const ADMIN_ID = 1;

const usersByUid: Record<string, any> = {
  [FRANK_UID]: { id: FRANK_ID, uid: FRANK_UID, user_name: 'Frank' },
  [ADMIN_UID]: { id: ADMIN_ID, uid: ADMIN_UID, user_name: 'Admin One' },
};

const authDeps = {
  verifyIdToken: jest.fn(async (token: string) => {
    const uid = token === 'frank-token' ? FRANK_UID : ADMIN_UID;
    return { uid, user_id: uid, admin: true };
  }),
  findUserByUid: jest.fn(async (uid: string) => usersByUid[uid] ?? null),
};
const asFrank = (r: request.Test) => r.set('Authorization', 'Bearer frank-token');
const asAdmin = (r: request.Test) => r.set('Authorization', 'Bearer admin-token');

const FINGERPRINT = {
  beers: { count: 2, md5: 'a'.repeat(32) },
  breweries: { count: 1, md5: 'b'.repeat(32) },
  beverage_images: { count: 0, md5: 'c'.repeat(32) },
};

interface State {
  batches: any[];
  candidates: any[];
  decisions: any[];
  pairs: any[];
  imageDecisions: any[];
  breweries: any[];
  styles: any[];
  manifests: any[];
  events: any[];
  eventSeq: number;
}

const baseState = (): State => ({
  batches: [{
    id: 3, slug: 'seed-batch', title: 'Seed batch', source: 'off',
    manifest: {}, bundle_sha256: 'e'.repeat(64), candidates_sha256: 'f'.repeat(64),
    record_count: 2, status: 'staged', ingested_by: null, ingested_at: new Date(),
  }],
  candidates: [
    {
      id: 11, batch_id: 3, candidate_key: 'off:1', payload: { name: 'Test Ale', brewery_name: 'Acme Brewing' },
      name: 'Test Ale', brewery_name: 'Acme Brewing', style: 'IPA', abv: 6.5, ibu: 60,
      barcode: '123456789012', description: 'A test ale.', review_status: 'selected',
      matched_beer_id: null, normalized_brewery: 'acme brewing',
      image_url: null, image_decision: null, image_decision_fetch_id: null,
    },
    {
      id: 12, batch_id: 3, candidate_key: 'off:2', payload: { name: 'Image Lager', brewery_name: 'Acme Brewing' },
      name: 'Image Lager', brewery_name: 'Acme Brewing', style: 'Lager', abv: 5.0, ibu: 20,
      barcode: null, description: 'A lager with an approved image.', review_status: 'selected',
      matched_beer_id: null, normalized_brewery: 'acme brewing',
      image_url: 'https://images.example/lager.png', image_decision: 'approved', image_decision_fetch_id: 51,
    },
  ],
  decisions: [
    { id: 5, candidate_id: 11, pair_id: null, decision: 'select', from_status: 'pending', to_status: 'selected' },
    { id: 6, candidate_id: 12, pair_id: null, decision: 'select', from_status: 'pending', to_status: 'selected' },
  ],
  pairs: [],
  imageDecisions: [{
    id: 9, candidate_id: 12, fetch_id: 51, image_ref: 'https://images.example/lager.png',
    image_sha256: 'ab'.repeat(32), decision: 'approved',
  }],
  breweries: [{ id: 4, name: 'Other Brewing' }],
  styles: [
    { id: 9, style_name: 'IPA', cat_id: 2 },
    { id: 10, style_name: 'Lager', cat_id: 3 },
  ],
  manifests: [],
  events: [],
  eventSeq: 0,
});

const buildHarness = (opts: {
  state?: State;
  writeConfigured?: boolean;
  approverIds?: number[];
} = {}) => {
  const state = opts.state ?? baseState();
  const withIncludes = (row: any, include: any) => {
    const out = { ...row };
    if (!include) return out;
    if (include.batch) out.batch = state.batches.find((b) => b.id === row.batch_id) ?? null;
    if (include.builder) out.builder = Object.values(usersByUid).find((u) => u.id === row.built_by) ?? null;
    if (include.approver) out.approver = Object.values(usersByUid).find((u) => u.id === row.approved_by) ?? null;
    if (include.actor) out.actor = Object.values(usersByUid).find((u) => u.id === row.actor_id) ?? null;
    return out;
  };
  const fingerprintRows = (table: keyof typeof FINGERPRINT) =>
    [{ count: FINGERPRINT[table].count, md5: FINGERPRINT[table].md5 }];

  const readPrisma: any = {
    discovery_batches: {
      findUnique: async ({ where }: any) => state.batches.find((b) => b.id === where.id) ?? null,
    },
    discovery_candidates: {
      findMany: async ({ where }: any) => state.candidates
        .filter((c) => c.batch_id === where.batch_id && c.review_status === where.review_status)
        .sort((a, b) => a.candidate_key.localeCompare(b.candidate_key)),
    },
    discovery_decisions: {
      findMany: async ({ where }: any) => state.decisions
        .filter((d) => where.candidate_id.in.includes(d.candidate_id) && d.pair_id === null)
        .sort((a, b) => b.id - a.id),
    },
    discovery_candidate_pairs: {
      findMany: async () => state.pairs.filter((p) => p.status === 'pending'),
    },
    discovery_image_decisions: {
      findMany: async ({ where }: any) => state.imageDecisions.filter((d) => where.fetch_id.in.includes(d.fetch_id)),
    },
    breweries: { findMany: async () => state.breweries },
    styles: { findMany: async () => state.styles },
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM beverage_images')) return fingerprintRows('beverage_images');
      if (sql.includes('FROM breweries')) return fingerprintRows('breweries');
      return fingerprintRows('beers');
    },
    discovery_import_manifests: {
      findUnique: async ({ where, include }: any) => {
        const row = state.manifests.find((m) => m.id === where.id);
        return row ? withIncludes(row, include) : null;
      },
      findMany: async ({ where, include }: any) => state.manifests
        .filter((m) => where.batch_id === undefined || m.batch_id === where.batch_id)
        .map((m) => withIncludes(m, include)),
      count: async ({ where }: any) =>
        state.manifests.filter((m) => where.batch_id === undefined || m.batch_id === where.batch_id).length,
    },
    discovery_manifest_events: {
      findMany: async ({ where, include }: any) => state.events
        .filter((e) => e.manifest_id === where.manifest_id)
        .map((e) => withIncludes(e, include)),
    },
  };

  const tx: any = {
    discovery_import_manifests: {
      create: async ({ data }: any) => {
        const row = {
          approved_by: null, approved_at: null, approved_sha256: null,
          imported_at: null, created_at: new Date(), ...data,
        };
        state.manifests.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const row = state.manifests.find((m) => m.id === where.id && m.status === where.status);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    discovery_manifest_events: {
      create: async ({ data }: any) => {
        const row = { id: ++state.eventSeq, created_at: new Date(), ...data };
        state.events.push(row);
        return row;
      },
    },
  };
  const writePrisma: any = opts.writeConfigured === false
    ? null
    : { $transaction: async (cb: any) => cb(tx) };

  const app = createApp({
    prisma: readPrisma,
    writePrisma: null,
    discoveryWritePrisma: writePrisma,
    presignGetUrl: null,
    discoveryManifestApproverIds: opts.approverIds ?? [FRANK_ID],
    ...authDeps,
  });
  return { app, state };
};

const buildManifest = async (app: any) => {
  const res = await asAdmin(request(app).post('/admin-api/v1/discovery/batches/3/manifests')).send({});
  expect(res.status).toBe(201);
  return res.body;
};

describe('manifest build', () => {
  it('builds a draft manifest over the selected candidates with a build event', async () => {
    const { app, state } = buildHarness();
    const body = await buildManifest(app);
    expect(body.id).toMatch(/^mf-seed-batch-\d{8}-01$/);
    expect(body.status).toBe('draft');
    expect(body.record_count).toBe(2);
    expect(body.can_approve).toBe(false); // built by admin, who is not allowlisted

    const stored = state.manifests[0];
    expect(stored.status).toBe('draft');
    expect(stored.built_by).toBe(ADMIN_ID);
    expect(manifestSha256(stored.manifest)).toBe(stored.sha256);
    expect(stored.manifest.records).toHaveLength(2);
    const imageRecord = stored.manifest.records.find((r: any) => r.candidate_id === 12);
    expect(imageRecord.image).toEqual({
      decision_id: 9, fetch_id: 51,
      ref: 'https://images.example/lager.png', sha256: 'ab'.repeat(32),
    });
    const plainRecord = stored.manifest.records.find((r: any) => r.candidate_id === 11);
    expect(plainRecord.image).toBeNull();
    expect(plainRecord.brewery).toEqual({ mode: 'new' });
    expect(stored.manifest.catalog_fingerprint).toEqual(FINGERPRINT);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ action: 'build', to_status: 'draft', actor_id: ADMIN_ID });
    expect(JSON.stringify(body)).not.toContain(ADMIN_UID);
  });

  it('refuses 422 with blockers when a selected candidate is not import-eligible, creating nothing', async () => {
    const state = baseState();
    state.candidates[1].image_decision = null; // image attached, never decided
    const { app } = buildHarness({ state });
    const res = await asAdmin(request(app).post('/admin-api/v1/discovery/batches/3/manifests')).send({});
    expect(res.status).toBe(422);
    expect(res.body.blockers).toEqual([
      { candidate_id: 12, candidate_key: 'off:2', reasons: ['image_unverified'] },
    ]);
    expect(res.body.error.message).toContain('off:2');
    expect(state.manifests).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });

  it('refuses 422 when the batch has no selected candidates', async () => {
    const state = baseState();
    state.candidates.forEach((c) => { c.review_status = 'pending'; });
    const { app } = buildHarness({ state });
    const res = await asAdmin(request(app).post('/admin-api/v1/discovery/batches/3/manifests')).send({});
    expect(res.status).toBe(422);
    expect(state.manifests).toHaveLength(0);
  });

  it('answers 404 for an unknown batch and 503 without the write path', async () => {
    const { app } = buildHarness();
    const missing = await asAdmin(request(app).post('/admin-api/v1/discovery/batches/999/manifests')).send({});
    expect(missing.status).toBe(404);
    const unconfigured = buildHarness({ writeConfigured: false });
    const res = await asAdmin(request(unconfigured.app).post('/admin-api/v1/discovery/batches/3/manifests')).send({});
    expect(res.status).toBe(503);
  });
});

describe('manifest approval (Frank\'s gate)', () => {
  it('approves a draft for the allowlisted caller and writes the audit event atomically', async () => {
    const { app, state } = buildHarness();
    const built = await buildManifest(app);
    const res = await asFrank(request(app).post(`/admin-api/v1/discovery/manifests/${built.id}/approve`))
      .send({ sha256: built.sha256 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.approved_sha256).toBe(built.sha256);
    expect(res.body.approved_by).toEqual({ id: FRANK_ID, user_name: 'Frank' });
    expect(res.body.can_approve).toBe(true);
    expect(state.events.map((e) => e.action)).toEqual(['build', 'approve']);
    expect(JSON.stringify(res.body)).not.toContain(FRANK_UID);
  });

  it('refuses 403 for a caller who is not on the allowlist', async () => {
    const { app, state } = buildHarness();
    const built = await buildManifest(app);
    const res = await asAdmin(request(app).post(`/admin-api/v1/discovery/manifests/${built.id}/approve`))
      .send({ sha256: built.sha256 });
    expect(res.status).toBe(403);
    expect(state.manifests[0].status).toBe('draft');
  });

  it('fails closed with 403 for everyone when the allowlist is empty', async () => {
    const { app } = buildHarness({ approverIds: [] });
    const built = await buildManifest(app);
    expect(built.can_approve).toBe(false);
    const res = await asFrank(request(app).post(`/admin-api/v1/discovery/manifests/${built.id}/approve`))
      .send({ sha256: built.sha256 });
    expect(res.status).toBe(403);
  });

  it('refuses 422 on a hash mismatch and 400 on a malformed hash', async () => {
    const { app, state } = buildHarness();
    const built = await buildManifest(app);
    const wrong = await asFrank(request(app).post(`/admin-api/v1/discovery/manifests/${built.id}/approve`))
      .send({ sha256: 'cd'.repeat(32) });
    expect(wrong.status).toBe(422);
    const malformed = await asFrank(request(app).post(`/admin-api/v1/discovery/manifests/${built.id}/approve`))
      .send({ sha256: 'not-a-hash' });
    expect(malformed.status).toBe(400);
    expect(state.manifests[0].status).toBe('draft');
    expect(state.events).toHaveLength(1); // build only
  });

  it('refuses 409 when the manifest is not in draft status', async () => {
    const { app } = buildHarness();
    const built = await buildManifest(app);
    const first = await asFrank(request(app).post(`/admin-api/v1/discovery/manifests/${built.id}/approve`))
      .send({ sha256: built.sha256 });
    expect(first.status).toBe(200);
    const second = await asFrank(request(app).post(`/admin-api/v1/discovery/manifests/${built.id}/approve`))
      .send({ sha256: built.sha256 });
    expect(second.status).toBe(409);
  });

  it('answers 503 without the write path and 404 for an unknown manifest', async () => {
    const { app } = buildHarness();
    const built = await buildManifest(app);
    const missing = await asFrank(request(app).post('/admin-api/v1/discovery/manifests/mf-nope-20261123-01/approve'))
      .send({ sha256: built.sha256 });
    expect(missing.status).toBe(404);
    const unconfigured = buildHarness({ writeConfigured: false });
    const state = unconfigured.state;
    state.manifests.push({
      id: built.id, batch_id: 3, manifest: {}, sha256: built.sha256, record_count: 0,
      catalog_fingerprint: {}, status: 'draft', built_by: ADMIN_ID, built_by_uid: ADMIN_UID,
      approved_by: null, approved_at: null, approved_sha256: null, imported_at: null,
      created_at: new Date(),
    });
    const res = await asFrank(request(unconfigured.app).post(`/admin-api/v1/discovery/manifests/${built.id}/approve`))
      .send({ sha256: built.sha256 });
    expect(res.status).toBe(503);
  });
});

describe('manifest void', () => {
  it('voids draft and approved manifests with an audit event; imported and void are final', async () => {
    const { app, state } = buildHarness();
    const built = await buildManifest(app);
    const voided = await asAdmin(request(app).post(`/admin-api/v1/discovery/manifests/${built.id}/void`))
      .send({ note: 'superseded by a rebuild' });
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe('void');
    expect(state.events.map((e) => e.action)).toEqual(['build', 'void']);
    expect(state.events[1].note).toBe('superseded by a rebuild');
    const again = await asAdmin(request(app).post(`/admin-api/v1/discovery/manifests/${built.id}/void`)).send({});
    expect(again.status).toBe(409);

    const built2 = await buildManifest(app);
    await asFrank(request(app).post(`/admin-api/v1/discovery/manifests/${built2.id}/approve`))
      .send({ sha256: built2.sha256 });
    const voidApproved = await asAdmin(request(app).post(`/admin-api/v1/discovery/manifests/${built2.id}/void`)).send({});
    expect(voidApproved.status).toBe(200);
    expect(voidApproved.body.status).toBe('void');

    state.manifests[0].status = 'imported';
    const voidImported = await asAdmin(request(app).post(`/admin-api/v1/discovery/manifests/${built.id}/void`)).send({});
    expect(voidImported.status).toBe(409);
  });
});

describe('manifest reads and export', () => {
  it('lists and details manifests with can_approve computed from the allowlist, and never leaks a UID', async () => {
    const { app } = buildHarness();
    const built = await buildManifest(app);
    const listAdmin = await asAdmin(request(app).get('/admin-api/v1/discovery/manifests'));
    expect(listAdmin.status).toBe(200);
    expect(listAdmin.body.results).toHaveLength(1);
    expect(listAdmin.body.results[0].can_approve).toBe(false);
    expect(listAdmin.body.results[0].sha256_short).toBe(built.sha256.slice(0, 12));
    const listFrank = await asFrank(request(app).get('/admin-api/v1/discovery/manifests'));
    expect(listFrank.body.results[0].can_approve).toBe(true);

    const detail = await asFrank(request(app).get(`/admin-api/v1/discovery/manifests/${built.id}`));
    expect(detail.status).toBe(200);
    expect(detail.body.records).toHaveLength(2);
    const imageRecord = detail.body.records.find((r: any) => r.candidate_id === 12);
    expect(imageRecord.image.sha256).toBe('ab'.repeat(32));
    expect(detail.body.catalog_fingerprint).toEqual(FINGERPRINT);
    expect(detail.body.events).toHaveLength(1);
    expect(JSON.stringify(detail.body)).not.toContain(FRANK_UID);
    expect(JSON.stringify(detail.body)).not.toContain(ADMIN_UID);

    const missing = await asAdmin(request(app).get('/admin-api/v1/discovery/manifests/mf-nope-20261123-01'));
    expect(missing.status).toBe(404);
  });

  it('exports bytes that are byte-identical to the hashed canonical content', async () => {
    const { app, state } = buildHarness();
    const built = await buildManifest(app);
    const res = await asAdmin(request(app).get(`/admin-api/v1/discovery/manifests/${built.id}/export`));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(`${built.id}.json`);
    expect(res.headers['x-manifest-sha256']).toBe(built.sha256);
    const text = (res as any).text as string;
    expect(text).toBe(canonicalManifestBytes(state.manifests[0].manifest));
    expect(sha256Hex(text)).toBe(built.sha256);
  });
});

describe('approver allowlist parsing', () => {
  it('parses comma-separated user ids and fails closed on junk', async () => {
    const { parseApproverAllowlist } = await import('./discoveryManifests');
    expect(parseApproverAllowlist(undefined)).toEqual([]);
    expect(parseApproverAllowlist('')).toEqual([]);
    expect(parseApproverAllowlist('7')).toEqual([7]);
    expect(parseApproverAllowlist('7, 12 ,x, -1, 3.5')).toEqual([7, 12]);
  });
});
