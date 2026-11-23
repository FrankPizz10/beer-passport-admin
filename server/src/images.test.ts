// Image resolution rules (server/src/images.ts):
// - an approved beverage_images row wins; public URLs are emitted as-is.
// - a bare storage_key names a private storage object and must NEVER be
//   emitted as image_url; image_url is null while kind/provenance remain.
// - no approved row falls back to the initials treatment.
import { resolveImage } from './images';

const row = (overrides: Record<string, unknown>) => ({
  beverage_id: 1,
  source_type: 'test',
  source_url: '',
  storage_key: '',
  license_type: 'CC0',
  attribution: '',
  license_url: '',
  ...overrides,
});

const prismaWith = (rows: unknown[]) => ({
  beverage_images: { findMany: async () => rows },
});

describe('resolveImage', () => {
  it('emits a public source_url', async () => {
    const prisma = prismaWith([
      row({ source_url: 'https://example.com/beer.jpg' }),
    ]);
    const fields = await resolveImage(prisma, { id: 1, cat_id: 1 });
    expect(fields.image_url).toBe('https://example.com/beer.jpg');
    expect(fields.image_kind).toBe('product');
  });

  it('prefers a storage_key that is a full URL', async () => {
    const prisma = prismaWith([
      row({
        source_url: 'https://example.com/source.jpg',
        storage_key: 'https://cdn.example.com/stored.jpg',
      }),
    ]);
    const fields = await resolveImage(prisma, { id: 1, cat_id: 1 });
    expect(fields.image_url).toBe('https://cdn.example.com/stored.jpg');
  });

  it('never emits a bare storage_key for a private object', async () => {
    const prisma = prismaWith([
      row({ source_url: '', storage_key: 'images/beers/1.jpg' }),
    ]);
    const fields = await resolveImage(prisma, { id: 1, cat_id: 1 });
    expect(fields.image_url).toBeNull();
    expect(fields.image_kind).toBe('product');
    expect(fields.image_provenance).not.toBeNull();
  });

  it('falls back to initials when no approved row exists', async () => {
    const fields = await resolveImage(prismaWith([]), { id: 1, cat_id: 1 });
    expect(fields.image_url).toBeNull();
    expect(fields.image_kind).toBe('initials');
  });
});
