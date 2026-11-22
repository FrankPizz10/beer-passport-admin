// Port of the pilot Discovery serialize module:
// ~/workspace/workstreams/pilot-impl/repo/src/Discovery/serialize.ts
// Stored 0 for abv, ibu, or srm means unknown and serializes as null.
// Empty string text serializes as null. Missing relations serialize as null.

export const unknownNumber = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined || value === 0) return null;
  return value;
};

export const emptyToNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  return value;
};

export type NamedRef = { id: number; name: string };

export const breweryRef = (
  brewery: { id: number; name: string } | null | undefined,
): NamedRef | null => (brewery ? { id: brewery.id, name: brewery.name } : null);

export const styleRef = (
  style: { id: number; style_name: string } | null | undefined,
): NamedRef | null => (style ? { id: style.id, name: style.style_name } : null);

export const categoryRef = (
  category: { id: number; cat_name: string } | null | undefined,
): NamedRef | null => (category ? { id: category.id, name: category.cat_name } : null);

export const collectionRef = (
  collection: { id: number; name: string } | null | undefined,
): NamedRef | null => (collection ? { id: collection.id, name: collection.name } : null);

export const beerRef = (
  beer: { id: number; name: string } | null | undefined,
): NamedRef | null => (beer ? { id: beer.id, name: beer.name } : null);
