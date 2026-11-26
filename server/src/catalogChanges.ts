import { createHash } from 'crypto';
import { conflict, invalidParameter, notFound } from './errors';
import { CATALOG_IMPORT_ADVISORY_LOCK_KEY } from './discoveryManifestCore';

export type CatalogEntity = 'beers' | 'breweries' | 'categories' | 'styles';
export type CatalogAction = 'edit' | 'archive';

type Field = { type: 'text' | 'number' | 'integer' | 'boolean'; nullable?: boolean; max?: number; min?: number; routine?: boolean };
export const CATALOG_FIELDS: Record<CatalogEntity, Record<string, Field>> = {
  beers: {
    name: { type: 'text', max: 255 }, brewery_id: { type: 'integer', nullable: true, min: 1 },
    cat_id: { type: 'integer', nullable: true, min: 1 }, style_id: { type: 'integer', nullable: true, min: 1 },
    abv: { type: 'number', nullable: true, min: 0, max: 100 }, ibu: { type: 'number', nullable: true, min: 0, max: 1000 },
    srm: { type: 'number', nullable: true, min: 0, max: 1000 }, upc: { type: 'text', nullable: true, max: 255 },
    descript: { type: 'text', nullable: true, max: 10000, routine: true }, discontinued: { type: 'boolean' },
  },
  breweries: {
    name: { type: 'text', max: 255 }, address1: { type: 'text', max: 255, routine: true },
    address2: { type: 'text', max: 255, routine: true }, city: { type: 'text', max: 255, routine: true },
    state: { type: 'text', max: 255, routine: true }, code: { type: 'text', max: 25, routine: true },
    country: { type: 'text', max: 255, routine: true }, phone: { type: 'text', max: 50, routine: true },
    website: { type: 'text', max: 255, routine: true }, descript: { type: 'text', max: 10000, routine: true },
  },
  categories: { cat_name: { type: 'text', max: 255 } },
  styles: { style_name: { type: 'text', max: 255 }, cat_id: { type: 'integer', nullable: true, min: 1 } },
};

export function parseEntity(raw: string): CatalogEntity {
  if (!Object.prototype.hasOwnProperty.call(CATALOG_FIELDS, raw)) throw notFound('Catalog type not found.');
  return raw as CatalogEntity;
}
export function parseChanges(entity: CatalogEntity, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidParameter('Changes must be an object.');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length) throw invalidParameter('Change at least one field.');
  const fields = CATALOG_FIELDS[entity];
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const field = fields[key];
    if (!field) throw invalidParameter(`Field ${key} cannot be edited.`);
    if (value === null && field.nullable) { out[key] = null; continue; }
    if (field.type === 'text') {
      if (typeof value !== 'string' || value.length > (field.max ?? 255)) throw invalidParameter(`Invalid ${key}.`);
      const clean = value.trim();
      if (['name', 'cat_name', 'style_name'].includes(key) && !clean) throw invalidParameter(`${key} is required.`);
      if (key === 'website' && clean) {
        try { if (!['https:', 'http:'].includes(new URL(clean).protocol)) throw new Error('Invalid scheme'); }
        catch { throw invalidParameter('Website must be an http or https URL.'); }
      }
      out[key] = clean;
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw invalidParameter(`Invalid ${key}.`);
      out[key] = value;
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value)) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) throw invalidParameter(`Invalid ${key}.`);
      out[key] = value;
    }
  }
  return out;
}

const normalize = (v: any): any => {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, normalize(v[k])]));
  return v;
};
export const snapshot = (row: any) => normalize(row);
export const fingerprint = (row: any) => createHash('sha256').update(JSON.stringify(snapshot(row))).digest('hex');
export const isRoutine = (entity: CatalogEntity, action: CatalogAction, changes: Record<string, unknown>) =>
  action === 'edit' && Object.keys(changes).every((key) => CATALOG_FIELDS[entity][key]?.routine === true);

export async function lockCatalog(tx: any) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${CATALOG_IMPORT_ADVISORY_LOCK_KEY})::text AS locked`;
}
export async function lockEntity(tx: any, entity: CatalogEntity, id: number) {
  // Static SQL per allowlisted type; never interpolate a table name.
  if (entity === 'beers') await tx.$queryRaw`SELECT id FROM beers WHERE id = ${id} FOR UPDATE`;
  else if (entity === 'breweries') await tx.$queryRaw`SELECT id FROM breweries WHERE id = ${id} FOR UPDATE`;
  else if (entity === 'categories') await tx.$queryRaw`SELECT id FROM categories WHERE id = ${id} FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM styles WHERE id = ${id} FOR UPDATE`;
  const row = await tx[entity].findUnique({ where: { id } });
  if (!row) throw notFound('Catalog entry not found.');
  return snapshot(row);
}

export async function checkArchiveDependencies(tx: any, entity: CatalogEntity, id: number) {
  if (entity === 'beers') {
    // A hidden beer must not leave a collection impossible to complete.
    // Existing images and user history remain attached to the archived row.
    const memberships = await tx.collection_beers.count({ where: { beer_id: id } });
    if (memberships) throw conflict(`This beer belongs to ${memberships} collection(s); resolve those memberships before archiving.`);
    return;
  }
  const beerWhere = entity === 'breweries' ? { brewery_id: id } : entity === 'categories' ? { cat_id: id } : { style_id: id };
  const beers = await tx.beers.count({ where: { ...beerWhere, archived_at: null } });
  const styles = entity === 'categories' ? await tx.styles.count({ where: { cat_id: id, archived_at: null } }) : 0;
  if (beers || styles) throw conflict(`Reassign or archive ${beers} active beer(s) and ${styles} active style(s) first.`);
}

export async function applyCatalogChange(tx: any, entity: CatalogEntity, id: number, action: CatalogAction, changes: Record<string, unknown>) {
  if (action === 'archive') await checkArchiveDependencies(tx, entity, id);
  if (action === 'edit' && (entity === 'beers' || entity === 'styles') && ['brewery_id', 'cat_id', 'style_id'].some((key) => key in changes)) {
    const current = await tx[entity].findUnique({ where: { id } });
    const proposed = { ...current, ...changes };
    if (entity === 'beers' && proposed.brewery_id !== null) {
      const brewery = await tx.breweries.findUnique({ where: { id: proposed.brewery_id } });
      if (!brewery || brewery.archived_at) throw conflict('The selected brewery is unavailable or archived.');
    }
    if (proposed.cat_id !== null) {
      const category = await tx.categories.findUnique({ where: { id: proposed.cat_id } });
      if (!category || category.archived_at) throw conflict('The selected category is unavailable or archived.');
    }
    if (entity === 'beers' && proposed.style_id !== null) {
      const style = await tx.styles.findUnique({ where: { id: proposed.style_id } });
      if (!style || style.archived_at) throw conflict('The selected style is unavailable or archived.');
      if (style.cat_id !== null && proposed.cat_id !== style.cat_id) throw conflict('The beer category must match its style category.');
    }
  }
  const data = action === 'archive' ? { archived_at: new Date(), last_mod: new Date() } : { ...changes, last_mod: new Date() };
  await tx[entity].update({ where: { id }, data });
  // Search vectors depend on beer, brewery and style names. Recompute them
  // within the same transaction so discovery never sees a stale index.
  if (action === 'edit' && ((entity === 'beers' && ['name', 'brewery_id', 'style_id'].some((key) => key in changes)) || (entity === 'breweries' && 'name' in changes) || (entity === 'styles' && 'style_name' in changes))) {
    const beerId = entity === 'beers' ? id : null;
    const breweryId = entity === 'breweries' ? id : null;
    const styleId = entity === 'styles' ? id : null;
    await tx.$executeRaw`UPDATE beers b SET search_vector = setweight(to_tsvector('english', b.name), 'A') || setweight(to_tsvector('english', COALESCE((SELECT name FROM breweries WHERE id = b.brewery_id), '')), 'B') || setweight(to_tsvector('english', COALESCE((SELECT style_name FROM styles WHERE id = b.style_id), '')), 'C') WHERE (${beerId}::int IS NOT NULL AND b.id = ${beerId}) OR (${breweryId}::int IS NOT NULL AND b.brewery_id = ${breweryId}) OR (${styleId}::int IS NOT NULL AND b.style_id = ${styleId})`;
  }
  return snapshot(await tx[entity].findUnique({ where: { id } }));
}
