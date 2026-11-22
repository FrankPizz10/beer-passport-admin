// Integration tests against the real local database. Skipped unless
// RUN_DB_TESTS=1. Read only: these tests never write to the database.
import request from 'supertest';
import { createApp } from '../src/app';
import { getPrisma } from '../src/db';

const run = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

run('integration against local database', () => {
  const prisma = getPrisma();
  const app = createApp({
    prisma,
    verifyIdToken: async () => ({ uid: 'integration-admin', user_id: 'integration-admin', admin: true }),
    findUserByUid: async () => ({ id: 1, uid: 'integration-admin' }),
  });
  const auth = (req: request.Test) => req.set('Authorization', 'Bearer integration-token');

  it('beers list total_results is 5894', async () => {
    const res = await auth(request(app).get('/admin-api/v1/catalog/beers?page_size=5'));
    expect(res.status).toBe(200);
    expect(res.body.pagination.total_results).toBe(5894);
    expect(res.body.results.length).toBe(5);
  });

  it('overview counts match catalog totals', async () => {
    const res = await auth(request(app).get('/admin-api/v1/admin/overview'));
    expect(res.status).toBe(200);
    expect(res.body.counts.beers).toBe(5894);
    expect(res.body.counts.breweries).toBe(1339);
    expect(res.body.counts.styles).toBe(147);
    expect(res.body.counts.categories).toBe(14);
  });

  it('known beer detail refs match a direct Prisma query', async () => {
    const first: any = await (prisma as any).beers.findFirst({ orderBy: { id: 'asc' }, select: { id: true, brewery_id: true, style_id: true } });
    const res = await auth(request(app).get('/admin-api/v1/catalog/beers/' + first.id));
    expect(res.status).toBe(200);
    if (first.brewery_id) {
      const brewery: any = await (prisma as any).breweries.findUnique({ where: { id: first.brewery_id }, select: { id: true, name: true } });
      expect(res.body.brewery).toEqual({ id: brewery.id, name: brewery.name });
    } else {
      expect(res.body.brewery).toBeNull();
    }
    if (first.style_id) {
      const style: any = await (prisma as any).styles.findUnique({ where: { id: first.style_id }, select: { id: true, style_name: true } });
      expect(res.body.style).toEqual({ id: style.id, name: style.style_name });
    } else {
      expect(res.body.style).toBeNull();
    }
  });

  it('users list total equals the real users count', async () => {
    const expected = await (prisma as any).users.count();
    const res = await auth(request(app).get('/admin-api/v1/users'));
    expect(res.status).toBe(200);
    expect(res.body.pagination.total_results).toBe(expected);
  });
});
