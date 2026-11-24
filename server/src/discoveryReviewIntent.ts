// Pure validation for the proposed review intent. The source payload remains
// immutable; reviewed values are a separate snapshot bound into a manifest.
export type ReviewedBeerFields = {
  name: string;
  brewery_name: string;
  style: string | null;
  abv: number | null;
  ibu: number | null;
  barcode: string | null;
  description: string | null;
};

export type ReviewIntent =
  | { mode: 'new_beer'; beer: ReviewedBeerFields }
  | { mode: 'image_only'; target_beer_id: number };

export class ReviewIntentError extends Error {}

const stringField = (value: unknown, field: string, max: number, required = false): string | null => {
  if (value === null && !required) return null;
  if (typeof value !== 'string') throw new ReviewIntentError(`${field} must be a string${required ? '' : ' or null'}`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ReviewIntentError(`${field} is required`);
  if (trimmed.length > max) throw new ReviewIntentError(`${field} exceeds ${max} characters`);
  // Keep the submitted bytes unchanged so an explicit accept-as-staged
  // decision does not silently rewrite the reviewed catalog values.
  return value;
};

const numericField = (value: unknown, field: string, max: number): number | null => {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new ReviewIntentError(`${field} must be null or a number between 0 and ${max}`);
  }
  return value;
};

export const parseReviewIntent = (input: unknown): ReviewIntent => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ReviewIntentError('intent must be an object');
  const obj = input as Record<string, unknown>;
  if (obj.mode === 'image_only') {
    if (Object.keys(obj).some(k => !['mode', 'target_beer_id'].includes(k)) ||
        !Number.isSafeInteger(obj.target_beer_id) || (obj.target_beer_id as number) <= 0) {
      throw new ReviewIntentError('image_only requires only a positive target_beer_id');
    }
    return { mode: 'image_only', target_beer_id: obj.target_beer_id as number };
  }
  if (obj.mode !== 'new_beer' || Object.keys(obj).some(k => !['mode', 'beer'].includes(k)) ||
      !obj.beer || typeof obj.beer !== 'object' || Array.isArray(obj.beer)) {
    throw new ReviewIntentError('intent must be new_beer with beer fields or image_only with a target');
  }
  const beer = obj.beer as Record<string, unknown>;
  const allowed = ['name', 'brewery_name', 'style', 'abv', 'ibu', 'barcode', 'description'];
  if (Object.keys(beer).some(k => !allowed.includes(k)) || allowed.some(k => !(k in beer))) {
    throw new ReviewIntentError('beer must contain exactly the reviewed fields');
  }
  return { mode: 'new_beer', beer: {
    name: stringField(beer.name, 'name', 600, true) as string,
    brewery_name: stringField(beer.brewery_name, 'brewery_name', 600, true) as string,
    style: stringField(beer.style, 'style', 255),
    abv: numericField(beer.abv, 'abv', 100),
    ibu: numericField(beer.ibu, 'ibu', 1000),
    barcode: stringField(beer.barcode, 'barcode', 64),
    description: stringField(beer.description, 'description', 10000),
  } };
};
