// Shared pagination, sorting, and id parsing for the admin API.
// Sorting scheme (the one scheme for this server, documented here):
//   ?sort=<field>&direction=<asc|desc>
// The field must be in the per resource allowlist passed by the handler.
// Default is field id, direction asc. A non allowlisted field or a bad
// direction is a 400. Page defaults to 1; page_size defaults to 25, min 1,
// max 100; non integer or out of range values are a 400 (plan sections 4.5
// and 7). Path ids that are not positive int4 integers are a 404, per plan
// 4.4. Query id filters that are malformed are a 400.
import { invalidParameter, notFound } from './errors';

export const MAX_INT4 = 2147483647;

export type Pagination = { page: number; pageSize: number };

export const parsePagination = (query: Record<string, unknown>): Pagination => {
  let page = 1;
  let pageSize = 25;
  if (query.page !== undefined) {
    page = Number(query.page as any);
    if (!Number.isInteger(page) || page < 1) {
      throw invalidParameter('page must be a positive integer.');
    }
  }
  if (query.page_size !== undefined) {
    pageSize = Number(query.page_size as any);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw invalidParameter('page_size must be between 1 and 100.');
    }
  }
  return { page, pageSize };
};

export type SortSpec = { field: string; direction: 'asc' | 'desc' };

export const parseSort = (
  query: Record<string, unknown>,
  allowlist: string[],
  defaultField = 'id',
  defaultDirection: 'asc' | 'desc' = 'asc',
): SortSpec => {
  const field = query.sort !== undefined ? String(query.sort) : defaultField;
  if (!allowlist.includes(field)) {
    throw invalidParameter('sort field is not allowed for this resource.');
  }
  let direction: 'asc' | 'desc' = defaultDirection;
  if (query.direction !== undefined) {
    const raw = String(query.direction);
    if (raw !== 'asc' && raw !== 'desc') {
      throw invalidParameter('direction must be asc or desc.');
    }
    direction = raw;
  }
  return { field, direction };
};

export const orderByFor = (sort: SortSpec): Record<string, string> => ({
  [sort.field]: sort.direction,
});

export const parseIdParam = (raw: unknown): number => {
  const value = Number(raw as any);
  if (!Number.isInteger(value) || value < 1 || value > MAX_INT4) {
    throw notFound('Resource not found.');
  }
  return value;
};

export const parseFilterId = (raw: unknown, name: string): number | null => {
  if (raw === undefined) return null;
  const value = Number(raw as any);
  if (!Number.isInteger(value) || value < 1 || value > MAX_INT4) {
    throw invalidParameter(name + ' must be a positive integer.');
  }
  return value;
};

export const parseBooleanFilter = (raw: unknown, name: string): boolean | null => {
  if (raw === undefined) return null;
  if (raw === 'true' || raw === true) return true;
  if (raw === 'false' || raw === false) return false;
  throw invalidParameter(name + ' must be true or false.');
};

export const paginationResult = (page: number, pageSize: number, total: number) => ({
  page,
  page_size: pageSize,
  total_results: total,
  total_pages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
});

export const skipFor = (p: Pagination): number => (p.page - 1) * p.pageSize;
