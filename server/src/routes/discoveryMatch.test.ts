// Discovery match suggestions route: response shape, ranking,
// 404, the bounded-scan exhaustive flag, and the 503 posture.
// Prisma dependencies are stubs; the DB-backed proof lives in
// test/discoveryMatch.integration.test.ts.
import express from 'express';
import request from 'supertest';
import { createApp } from '../app';
import { createDiscoveryMatchRouter } from './discoveryMatch';

const adminDeps = {
  resolveAdminAccess: async () => 'owner' as const,
  verifyIdToken: jest.fn(async () => ({ uid: 'admin-uid', user_id: 'admin-uid', admin: true })),
  findUserByUid: jest.fn(async () => ({ id: 1, uid: 'admin-uid' })),
};

const beerRow = (id: number, name: string, breweryName: string, upc: string | null = null) => ({
  id, name, abv: 5.0, upc, brewery: { name: breweryName },
});

const CANDIDATES: Record<number, any> = {
  61: { id: 61, name: 'Bud Light', brewery_name: 'Budweiser', barcode: null },
  63: { id: 63, name: 'Pale Ale', brewery_name: 'Example Brewing', barcode: null },
};

const BEERS = [
  beerRow(3784, 'Bud Light', 'Anheuser-Busch', '018200530401'),
  beerRow(41, 'Bud Light Lime', 'Anheuser-Busch'),
  ...Array.from({ length: 12 }, (_v, i) => beerRow(100 + i, `Pale Ale ${i}`, 'Example Brewing')),
];

const stubPrisma = () => ({
  discovery_candidates: {
    findUnique: jest.fn(async ({ where }: any) => CANDIDATES[where.id] || null),
  },
  beers: {
    findMany: jest.fn(async (args: any) => {
      let rows = [...BEERS];
      const where = args.where || {};
      if (where.upc) rows = rows.filter((b) => b.upc === where.upc);
      else if (where.name && where.name.equals) {
        rows = rows.filter((b) => b.name.toLowerCase() === where.name.equals.toLowerCase());
      } else if (where.OR) {
        const needles = where.OR.map((c: any) =>
          (c.name ? c.name.contains : c.brewery.name.contains).toLowerCase());
        rows = rows.filter((b) =>
          needles.some((n: string) =>
            b.name.toLowerCase().includes(n) || b.brewery.name.toLowerCase().includes(n)));
        rows.sort((a, b) => a.id - b.id);
      }
      return rows.slice(0, args.take ?? rows.length);
    }),
  },
});

const auth = (req: request.Test) => req.set('Authorization', 'Bearer <redacted>');

describe('GET /discovery/candidates/:id/match-suggestions (app wiring)', () => {
  it('returns the contracted shape with the right beer ranked first', async () => {
    const app = createApp({ ...adminDeps, prisma: stubPrisma() } as any);
    const res = await auth(request(app).get('/admin-api/v1/discovery/candidates/61/match-suggestions'));
    expect(res.status).toBe(200);
    expect(res.body.candidate_id).toBe(61);
    expect(res.body.exhaustive).toBe(false);
    expect(typeof res.body.scanned).toBe('number');
    expect(res.body.suggestions[0]).toEqual({
      beer_id: 3784,
      name: 'Bud Light',
      brewery_name: 'Anheuser-Busch',
      abv: 5.0,
      barcode: '018200530401',
      score: expect.any(Number),
      evidence: expect.arrayContaining(['name_exact']),
    });
    // Advisory only: nothing in the payload marks a chosen target.
    expect(JSON.stringify(res.body)).not.toContain('chosen');
  });

  it('404s for a missing candidate with the sibling error shape', async () => {
    const app = createApp({ ...adminDeps, prisma: stubPrisma() } as any);
    const res = await auth(request(app).get('/admin-api/v1/discovery/candidates/999/match-suggestions'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.message).toBe('Discovery candidate not found.');
  });

  it('requires auth like every discovery route', async () => {
    const app = createApp({ ...adminDeps, prisma: stubPrisma() } as any);
    const res = await request(app).get('/admin-api/v1/discovery/candidates/61/match-suggestions');
    expect(res.status).toBe(401);
  });
});

describe('createDiscoveryMatchRouter bounds and configuration', () => {
  const bareApp = (prisma: any, opts?: any) => {
    const app = express();
    app.use(createDiscoveryMatchRouter(prisma, opts));
    return app;
  };

  it('reports exhaustive=false when the scan cap binds', async () => {
    const res = await request(bareApp(stubPrisma(), { scanCap: 3 }))
      .get('/discovery/candidates/63/match-suggestions');
    expect(res.status).toBe(200);
    expect(res.body.exhaustive).toBe(false);
    expect(res.body.scanned).toBe(3);
  });

  it('answers 503 when no read client is configured', async () => {
    const res = await request(bareApp(null)).get('/discovery/candidates/61/match-suggestions');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('service_unavailable');
  });
});
