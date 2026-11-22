import { parsePagination, parseSort } from './pagination';

const expect400 = (fn: () => unknown) => {
  try { fn(); fail('expected throw'); } catch (e: any) { expect(e.status).toBe(400); }
};

describe('pagination', () => {
  it('page=0 returns 400', () => expect400(() => parsePagination({ page: '0' })));
  it('page=abc returns 400', () => expect400(() => parsePagination({ page: 'abc' })));
  it('page_size=101 returns 400', () => expect400(() => parsePagination({ page_size: '101' })));
  it('page_size=100 is ok', () => { expect(parsePagination({ page_size: '100' }).pageSize).toBe(100); });
  it('defaults are page 1 and page_size 25', () => { const p = parsePagination({}); expect(p.page).toBe(1); expect(p.pageSize).toBe(25); });
  it('sort field not in allowlist returns 400', () => expect400(() => parseSort({ sort: 'evil' }, ['id', 'name'])));
  it('direction sideways returns 400', () => expect400(() => parseSort({ sort: 'id', direction: 'sideways' }, ['id'])));
  it('valid sort parses', () => { expect(parseSort({ sort: 'name', direction: 'desc' }, ['id', 'name'])).toEqual({ field: 'name', direction: 'desc' }); });
});
