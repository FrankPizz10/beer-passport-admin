// Live rehearsal for discovery match suggestions against a
// disposable database. Skipped unless RUN_DB_TESTS=1. Provisions
// come from server/scripts/test-discovery-match.sh: base catalog
// schema + migrations 001-005 and the viewer role. The suite seeds
// its OWN small catalog and staged batch through the owner client
// (DISCOVERY_TEST_OWNER_URL) and drives the endpoint through the
// real app on the read-only viewer client, so the proof covers the
// actual role posture: the endpoint needs SELECT only.
//
// Clients are constructed lazily inside beforeAll: a PrismaClient
// built at describe-body level would throw on a missing URL even
// when the suite is skipped.
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app';
import { createDiscoveryMatchRouter } from '../src/routes/discoveryMatch';

const run = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(120000);

run('discovery match suggestions against the disposable database', () => {
  let owner: PrismaClient;
  let viewer: PrismaClient;
  let app: any;
  let budLightId = 0;
  let batchId = 0;
  let budCandidateId = 0;
  let barcodeCandidateId = 0;
  let noMatchCandidateId = 0;
  const seededBeerIds: number[] = [];
  const seededBreweryIds: number[] = [];

  const auth = (req: request.Test) => req.set('Authorization', 'Bearer <redacted>');

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: process.env.DISCOVERY_TEST_OWNER_URL } } });
    viewer = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    const ab = await owner.breweries.create({ data: { name: 'Anheuser-Busch', descript: '' } });
    const sn = await owner.breweries.create({ data: { name: 'Sierra Nevada', descript: '' } });
    const fw = await owner.breweries.create({ data: { name: 'Firestone Walker', descript: '' } });
    seededBreweryIds.push(ab.id, sn.id, fw.id);

    const mkBeer = async (brewery_id: number, name: string, upc: string | null) => {
      const beer = await owner.beers.create({ data: { brewery_id, name, abv: 5.0, upc } });
      seededBeerIds.push(beer.id);
      return beer.id;
    };
    budLightId = await mkBeer(ab.id, 'Bud Light', '018200530401');
    await mkBeer(ab.id, 'Bud Light Lime', null);
    await mkBeer(sn.id, 'Pale Ale', null);
    await mkBeer(fw.id, 'Pale Ale', null);
    // Extra token-sharing rows so a forced-low scan cap can bind.
    for (let i = 0; i < 6; i++) await mkBeer(sn.id, `Pale Ale Reserve ${i}`, null);

    const batch = await owner.discovery_batches.create({
      data: {
        slug: 'match-suggestions-rehearsal',
        title: 'Match suggestions rehearsal',
        source: 'rehearsal',
        manifest: {},
        bundle_sha256: 'b'.repeat(64),
        candidates_sha256: 'c'.repeat(64),
        record_count: 3,
      },
    });
    batchId = batch.id;

    const mkCandidate = async (name: string, brewery_name: string | null, barcode: string | null) => {
      const c = await owner.discovery_candidates.create({
        data: {
          batch_id: batchId,
          candidate_key: `rehearsal:${name}`,
          payload: {},
          name,
          brewery_name,
          barcode,
          source: 'rehearsal',
          source_record_id: name,
          normalized_name: name.toLowerCase(),
          normalized_brewery: brewery_name ? brewery_name.toLowerCase() : null,
        },
      });
      return c.id;
    };
    budCandidateId = await mkCandidate('Bud Light', 'Budweiser', null);
    barcodeCandidateId = await mkCandidate('Hazy Wander', 'Other Brewing', '018200530401');
    noMatchCandidateId = await mkCandidate('Zqx Wobble Juice', 'Nowhere Brewing', null);

    app = createApp({
      resolveAdminAccess: async () => 'owner',
      prisma: viewer,
      verifyIdToken: async () => ({ uid: 'integration-admin', user_id: 'integration-admin', admin: true }),
      findUserByUid: async () => ({ id: 1, uid: 'integration-admin' }),
    } as any);
  });

  afterAll(async () => {
    await owner.discovery_candidates.deleteMany({ where: { batch_id: batchId } });
    await owner.discovery_batches.deleteMany({ where: { id: batchId } });
    await owner.beers.deleteMany({ where: { id: { in: seededBeerIds } } });
    await owner.breweries.deleteMany({ where: { id: { in: seededBreweryIds } } });
    await owner.$disconnect();
    await viewer.$disconnect();
  });

  it('ranks the catalog Bud Light first for the staged Bud Light, on name evidence only', async () => {
    const res = await auth(request(app).get(`/admin-api/v1/discovery/candidates/${budCandidateId}/match-suggestions`));
    expect(res.status).toBe(200);
    expect(res.body.candidate_id).toBe(budCandidateId);
    expect(res.body.exhaustive).toBe(false);
    expect(res.body.scanned).toBeGreaterThan(0);
    const first = res.body.suggestions[0];
    expect(first.beer_id).toBe(budLightId);
    expect(first.name).toBe('Bud Light');
    expect(first.brewery_name).toBe('Anheuser-Busch');
    expect(first.barcode).toBe('018200530401');
    expect(first.evidence).toContain('name_exact');
    expect(first.evidence).not.toContain('brewery_match');
  });

  it('a barcode-carrying candidate surfaces the barcode beer first', async () => {
    const res = await auth(request(app).get(`/admin-api/v1/discovery/candidates/${barcodeCandidateId}/match-suggestions`));
    expect(res.status).toBe(200);
    expect(res.body.suggestions[0].beer_id).toBe(budLightId);
    expect(res.body.suggestions[0].evidence).toContain('barcode_exact');
  });

  it('a no-match candidate returns an empty list with exhaustive=false', async () => {
    const res = await auth(request(app).get(`/admin-api/v1/discovery/candidates/${noMatchCandidateId}/match-suggestions`));
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
    expect(res.body.exhaustive).toBe(false);
  });

  it('404s for a candidate that does not exist', async () => {
    const res = await auth(request(app).get('/admin-api/v1/discovery/candidates/999999999/match-suggestions'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('reports exhaustive=false when the scan cap is forced low', async () => {
    const pale = await owner.discovery_candidates.create({
      data: {
        batch_id: batchId,
        candidate_key: 'rehearsal:Pale Ale',
        payload: {},
        name: 'Pale Ale',
        brewery_name: 'Sierra Nevada Brewing',
        barcode: null,
        source: 'rehearsal',
        source_record_id: 'Pale Ale',
        normalized_name: 'pale ale',
        normalized_brewery: 'sierra nevada brewing',
      },
    });
    const bare = express();
    bare.use(createDiscoveryMatchRouter(viewer, { scanCap: 2 }));
    const res = await request(bare).get(`/discovery/candidates/${pale.id}/match-suggestions`);
    expect(res.status).toBe(200);
    expect(res.body.exhaustive).toBe(false);
    expect(res.body.scanned).toBe(2);
    await owner.discovery_candidates.delete({ where: { id: pale.id } });
  });
});
