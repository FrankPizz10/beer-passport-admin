// Port of the pilot Discovery image resolver:
// ~/workspace/workstreams/pilot-impl/repo/src/Discovery/images.ts
// Resolution order: an approved beverage_images row wins (lowest id first);
// the category illustration map is intentionally empty, so the fallback is
// the initials treatment with image_url null. A storage_key starting with
// http wins, else source_url, else storage_key.
export type ImageFields = {
  image_url: string | null;
  image_kind: 'product' | 'category' | 'initials';
  image_provenance: {
    tier: string;
    source_type: string;
    license_type: string;
    attribution: string;
    license_url: string;
  } | null;
};

const CATEGORY_ILLUSTRATIONS: Record<number, string> = {};

type ImageRow = {
  beverage_id: number;
  source_type: string;
  source_url: string;
  storage_key: string;
  license_type: string;
  attribution: string;
  license_url: string;
};

export const deriveTier = (licenseType: string): 'A' | 'B' | 'C' => {
  const license = (licenseType || '').toUpperCase();
  if (
    license.includes('CC0') ||
    license.includes('PUBLIC DOMAIN') ||
    license.startsWith('CC BY')
  ) {
    return 'A';
  }
  if (license.includes('ALL RIGHTS RESERVED') || license.includes('PROPRIETARY')) {
    return 'C';
  }
  return 'B';
};

const toImageFields = (row: ImageRow): ImageFields => ({
  image_url: row.storage_key && row.storage_key.startsWith('http')
    ? row.storage_key
    : row.source_url || row.storage_key || null,
  image_kind: 'product',
  image_provenance: {
    tier: deriveTier(row.license_type),
    source_type: row.source_type,
    license_type: row.license_type,
    attribution: row.attribution,
    license_url: row.license_url,
  },
});

const fallbackFields = (categoryId: number | null | undefined): ImageFields => {
  const illustration =
    categoryId !== null && categoryId !== undefined
      ? CATEGORY_ILLUSTRATIONS[categoryId]
      : undefined;
  if (illustration) {
    return { image_url: illustration, image_kind: 'category', image_provenance: null };
  }
  return { image_url: null, image_kind: 'initials', image_provenance: null };
};

export const resolveImages = async (
  prisma: any,
  beers: { id: number; cat_id?: number | null }[],
): Promise<Map<number, ImageFields>> => {
  const result = new Map<number, ImageFields>();
  if (beers.length === 0) return result;
  const rows: ImageRow[] = await prisma.beverage_images.findMany({
    where: { beverage_id: { in: beers.map((b) => b.id) }, status: 'approved' },
    orderBy: { id: 'asc' },
  });
  const byBeer = new Map<number, ImageRow>();
  for (const row of rows) {
    if (!byBeer.has(row.beverage_id)) byBeer.set(row.beverage_id, row);
  }
  for (const beer of beers) {
    const row = byBeer.get(beer.id);
    result.set(beer.id, row ? toImageFields(row) : fallbackFields(beer.cat_id));
  }
  return result;
};

export const resolveImage = async (
  prisma: any,
  beer: { id: number; cat_id?: number | null },
): Promise<ImageFields> => {
  const map = await resolveImages(prisma, [beer]);
  return map.get(beer.id) as ImageFields;
};
