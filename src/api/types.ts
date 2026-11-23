export interface PaginationInfo {
  page: number;
  page_size: number;
  total_results: number;
  total_pages: number;
}

export interface ListResponse<T> {
  results: T[];
  pagination: PaginationInfo;
}

export interface Ref {
  id: number;
  name: string;
}

export interface OverviewCounts {
  [table: string]: number;
}

// Response of GET /admin-api/v1/admin/overview: the server sends the
// counts map under `counts` AND spreads the same keys at the top level
// ({ counts, ...counts }). Consumers must read `counts`; iterating the
// whole body yields the nested counts object as a value.
export interface OverviewResponse {
  counts: OverviewCounts;
  [table: string]: number | OverviewCounts;
}

export interface TargetInfo {
  host: string | null;
  port: number | null;
  database: string | null;
  firebase_configured: boolean;
}

export interface Beer {
  id: number;
  name: string;
  abv: number | null;
  ibu: number | null;
  srm: number | null;
  upc: string | null;
  descript?: string | null;
  discontinued: boolean;
  last_mod: string;
  brewery_id?: number | null;
  style_id?: number | null;
  cat_id?: number | null;
  brewery: Ref | null;
  style: Ref | null;
  category: Ref | null;
  image_url: string | null;
  image_kind: "product" | "category" | "initials";
  image_provenance: ImageProvenance | null;
}

export interface ImageProvenance {
  tier?: string | null;
  source_type?: string | null;
  source_url?: string | null;
  storage_key?: string | null;
  license_type?: string | null;
  attribution?: string | null;
  license_url?: string | null;
  status?: string | null;
}

export interface BeerDetail extends Beer {
  collections: Ref[];
  user_beers_count: number;
  liked_count: number;
  counts?: { user_beers: number; liked_user_beers: number };
}

// Response of GET /admin-api/v1/images/:beverageId: a short-lived
// presigned GET URL for an approved private image, plus its expiry.
export interface PresignedImageResponse {
  url: string;
  expires_at: string;
}

export interface Brewery {
  id: number;
  name: string;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  code?: string | null;
  country?: string | null;
  phone?: string | null;
  website?: string | null;
  descript?: string | null;
  add_user?: number | null;
  last_mod?: string;
  beer_count: number;
}

export interface Geocode {
  id: number;
  brewery_id: number;
  latitude: number | string;
  longitude: number | string;
  accuracy: string;
}

// Response of GET /admin-api/v1/catalog/breweries/:id is FLAT: the
// brewery fields, a plain array of serialized beer rows under `beers`,
// and the pagination object at the top level (duplicated as
// `beers_pagination`). It is NOT a ListResponse envelope.
export interface BreweryDetail extends Brewery {
  geocode: Geocode | null;
  beers: Beer[];
  pagination: PaginationInfo;
  beers_pagination: PaginationInfo;
}

export interface Category {
  id: number;
  cat_name?: string;
  name?: string;
  last_mod?: string;
  beer_count?: number;
  style_count?: number;
}

// Response of GET /admin-api/v1/catalog/categories/:id: the category
// fields (with `name` mirroring cat_name), a plain array of styles,
// and beer_count. The endpoint returns NO beers and NO pagination;
// category beers come from GET /catalog/beers?category_id=:id.
export interface CategoryDetail extends Category {
  styles: { id: number; style_name: string; name: string; cat_id: number; last_mod: string }[];
  beer_count: number;
}

export interface Style {
  id: number;
  style_name?: string;
  name?: string;
  last_mod?: string;
  category?: Ref | null;
  beer_count?: number;
}

// Response of GET /admin-api/v1/catalog/styles/:id: the style fields
// (with `name` mirroring style_name), a category ref, and beer_count.
// Like category detail it returns NO beers and NO pagination; style
// beers come from GET /catalog/beers?style_id=:id.
export interface StyleDetail extends Style {
  category: Ref | null;
  beer_count: number;
}

export interface Collection {
  id: number;
  name: string;
  difficulty?: number | null;
  description?: string | null;
  created_at?: string;
  updated_at?: string;
  beer_count?: number;
  member_count?: number;
  badge_holder_count?: number;
}

export interface CollectionBeerRow {
  id: number;
  collection_id?: number;
  beer_id?: number;
  beer?: Ref | null;
  collection?: Ref | null;
  created_at?: string;
  updated_at?: string;
}

// One member row of a collection detail response: a collection_beers
// row id plus refs to the beer (and, on `beers`, the collection).
export interface CollectionMemberRow {
  id: number;
  beer: Ref | null;
  collection?: Ref | null;
  created_at: string;
}

// Response of GET /admin-api/v1/catalog/collections/:id is FLAT: the
// collection fields, plain arrays of member rows under `beers` and
// `members`, and the pagination object at the top level.
export interface CollectionDetail extends Collection {
  beers: CollectionMemberRow[];
  members: CollectionMemberRow[];
  pagination: PaginationInfo;
  badge_holder_count: number;
}

export interface BeverageImage {
  id: number;
  beverage_id: number;
  source_type?: string | null;
  source_url?: string | null;
  storage_key?: string | null;
  license_type?: string | null;
  attribution?: string | null;
  license_url?: string | null;
  status: string;
  verified_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AppUser {
  id: number;
  user_name: string;
  email: string;
  age: number | null;
  private: boolean;
  created_at: string;
  tried_count: number;
  badge_count: number;
}

export interface UserDetail extends AppUser {
  uid: string;
  updated_at?: string;
  notification_count?: number;
  friend_count?: number;
  counts?: {
    user_beers: number;
    user_badges: number;
    notifications: number;
  };
}

export interface UserBeerRow {
  id: number;
  beer: Ref;
  liked: boolean;
  created_at: string;
}

export interface UserBadgeRow {
  id: number;
  collection: Ref;
  earned: boolean;
  progress: number;
  created_at?: string;
}

export interface UserFriendRow {
  id: number;
  other_user: { id: number; user_name: string } | null;
  created_at: string;
}

export interface UserNotificationRow {
  id: number;
  type: string;
  message: string;
  viewed: boolean;
  created_at: string;
}

export interface AdminAccount {
  uid: string;
  email: string | null;
  is_admin: boolean;
  created_at: string | null;
  last_sign_in_at: string | null;
  disabled: boolean;
}

export interface AccountsResponse {
  results: AdminAccount[];
  next_cursor: string | null;
  firebase_configured: boolean;
}

export interface ApiKey {
  id: number;
  name: string;
  revoked: boolean;
  created_at: string;
  last_used_at: string | null;
  last_mod: string;
}
