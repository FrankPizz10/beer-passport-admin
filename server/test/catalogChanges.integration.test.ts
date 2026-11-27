import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app';

const enabled = process.env.RUN_CATALOG_CHANGES_DB_TESTS === '1';
(enabled ? describe : describe.skip)('catalog changes on disposable PostgreSQL', () => {
  let ownerDb: PrismaClient;
  let writer: PrismaClient;
  let app: ReturnType<typeof createApp>;
  const as = (role: 'owner' | 'reviewer', req: request.Test) => req.set('Authorization', `Bearer ${role}`);
  const options = async (entity = 'beers', id = 1) => {
    const result = await as('reviewer', request(app).get(`/admin-api/v1/catalog/change-options/${entity}/${id}`));
    expect(result.status).toBe(200);
    return result.body;
  };
  beforeAll(() => {
    process.env.CATALOG_ARCHIVE_ENABLED = 'true';
    ownerDb = new PrismaClient({ datasources: { db: { url: process.env.CATALOG_TEST_OWNER_URL } } });
    writer = new PrismaClient({ datasources: { db: { url: process.env.CATALOG_TEST_WRITER_URL } } });
    app = createApp({
      prisma: ownerDb, catalogWritePrisma: writer, adminAccessWritePrisma: null,
      discoveryWritePrisma: null, writePrisma: null, presignGetUrl: null,
      verifyIdToken: async (token) => ({ uid: token }),
      findUserByUid: async (uid) => ({ id: uid === 'owner' ? 1 : 2 }),
      resolveAdminAccess: async (uid) => uid === 'owner' ? 'owner' : uid === 'reviewer' ? 'admin' : null,
    });
  });
  afterAll(async () => { delete process.env.CATALOG_ARCHIVE_ENABLED; await ownerDb.$disconnect(); await writer.$disconnect(); });

  it('applies routine edits with an audit and requires owner approval for names', async () => {
    let state = await options();
    const routine = await as('reviewer', request(app).post('/admin-api/v1/catalog/change-options/beers/1/requests'))
      .send({ action: 'edit', version: state.version, changes: { descript: 'New description' }, reason: 'Fix description' });
    expect(routine.status).toBe(201);
    expect(routine.body.status).toBe('applied');
    expect((await ownerDb.beers.findUnique({ where: { id: 1 } }))?.descript).toBe('New description');
    const events = await ownerDb.catalog_change_events.findMany({ where: { request_id: routine.body.id }, orderBy: { id: 'asc' } });
    expect(events.map((event) => event.action)).toEqual(['requested', 'applied']);
    state = await options();
    const risky = await as('reviewer', request(app).post('/admin-api/v1/catalog/change-options/beers/1/requests'))
      .send({ action: 'edit', version: state.version, changes: { name: 'Renamed Beer' }, reason: 'Correct product name' });
    expect(risky.status).toBe(201);
    expect(risky.body.status).toBe('pending');
    expect((await as('reviewer', request(app).post(`/admin-api/v1/catalog/changes/${risky.body.id}/approve`))).status).toBe(403);
    expect((await as('owner', request(app).post(`/admin-api/v1/catalog/changes/${risky.body.id}/approve`))).status).toBe(200);
    const search: any[] = await ownerDb.$queryRaw`SELECT search_vector @@ to_tsquery('english', 'renam') AS found FROM beers WHERE id = 1`;
    expect(search[0].found).toBe(true);
  });

  it('rejects stale requests rather than overwriting a later edit', async () => {
    const state = await options();
    const pending = await as('reviewer', request(app).post('/admin-api/v1/catalog/change-options/beers/1/requests'))
      .send({ action: 'edit', version: state.version, changes: { name: 'Stale name' }, reason: 'Rename' });
    expect(pending.status).toBe(201);
    const edit = await as('reviewer', request(app).post('/admin-api/v1/catalog/change-options/beers/1/requests'))
      .send({ action: 'edit', version: state.version, changes: { descript: 'Changed after request' }, reason: 'Correct description' });
    expect(edit.body.status).toBe('applied');
    expect((await as('owner', request(app).post(`/admin-api/v1/catalog/changes/${pending.body.id}/approve`))).status).toBe(409);
    expect((await ownerDb.beers.findUnique({ where: { id: 1 } }))?.name).toBe('Renamed Beer');
  });

  it('archives and restores a beer without deleting images or user history', async () => {
    const state = await options();
    const pending = await as('reviewer', request(app).post('/admin-api/v1/catalog/change-options/beers/1/requests'))
      .send({ action: 'archive', version: state.version, reason: 'Duplicate product' });
    expect(pending.body.status).toBe('pending');
    expect((await as('owner', request(app).post(`/admin-api/v1/catalog/changes/${pending.body.id}/approve`))).status).toBe(200);
    expect((await ownerDb.beers.findUnique({ where: { id: 1 } }))?.archived_at).not.toBeNull();
    const dependencies: any[] = await ownerDb.$queryRaw`SELECT (SELECT count(*)::int FROM beverage_images WHERE beverage_id = 1) AS images, (SELECT count(*)::int FROM user_beers WHERE beer_id = 1) AS history`;
    expect(dependencies[0]).toEqual({ images: 1, history: 1 });
    expect((await as('owner', request(app).post(`/admin-api/v1/catalog/changes/${pending.body.id}/revert`))).status).toBe(200);
    expect((await ownerDb.beers.findUnique({ where: { id: 1 } }))?.archived_at).toBeNull();
  });

  it('refuses to archive a brewery while active beers depend on it', async () => {
    const state = await options('breweries');
    const pending = await as('reviewer', request(app).post('/admin-api/v1/catalog/change-options/breweries/1/requests'))
      .send({ action: 'archive', version: state.version, reason: 'No longer needed' });
    expect(pending.status).toBe(201);
    expect((await as('owner', request(app).post(`/admin-api/v1/catalog/changes/${pending.body.id}/approve`))).status).toBe(409);
    expect((await ownerDb.breweries.findUnique({ where: { id: 1 } }))?.archived_at).toBeNull();
  });

  it('refuses to revert an older edit over a newer one', async () => {
    const firstState = await options();
    const first = await as('reviewer', request(app).post('/admin-api/v1/catalog/change-options/beers/1/requests'))
      .send({ action: 'edit', version: firstState.version, changes: { descript: 'First update' }, reason: 'Edit one' });
    expect(first.body.status).toBe('applied');
    const secondState = await options();
    const second = await as('reviewer', request(app).post('/admin-api/v1/catalog/change-options/beers/1/requests'))
      .send({ action: 'edit', version: secondState.version, changes: { descript: 'Second update' }, reason: 'Edit two' });
    expect(second.body.status).toBe('applied');
    expect((await as('owner', request(app).post(`/admin-api/v1/catalog/changes/${first.body.id}/revert`))).status).toBe(409);
    expect((await ownerDb.beers.findUnique({ where: { id: 1 } }))?.descript).toBe('Second update');
  });

  it('fails closed for archiving when the consumer rollout is incomplete', async () => {
    process.env.CATALOG_ARCHIVE_ENABLED = 'false';
    try {
      const state = await options();
      const result = await as('reviewer', request(app).post('/admin-api/v1/catalog/change-options/beers/1/requests'))
        .send({ action: 'archive', version: state.version, reason: 'Duplicate' });
      expect(result.status).toBe(503);
      expect((await ownerDb.beers.findUnique({ where: { id: 1 } }))?.archived_at).toBeNull();
    } finally { process.env.CATALOG_ARCHIVE_ENABLED = 'true'; }
  });

  it('does not archive a beer that is still needed by a collection', async () => {
    await ownerDb.$executeRaw`INSERT INTO collection_beers (collection_id, beer_id) VALUES (3, 1)`;
    const state = await options();
    const pending = await as('reviewer', request(app).post('/admin-api/v1/catalog/change-options/beers/1/requests'))
      .send({ action: 'archive', version: state.version, reason: 'Duplicate' });
    const result = await as('owner', request(app).post(`/admin-api/v1/catalog/changes/${pending.body.id}/approve`));
    expect(result.status).toBe(409);
    expect(result.body.error.message).toMatch(/collection/);
    expect((await ownerDb.beers.findUnique({ where: { id: 1 } }))?.archived_at).toBeNull();
  });
});
