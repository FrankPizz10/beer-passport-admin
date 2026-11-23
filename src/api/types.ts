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

export interface TargetInfo {
  host: string;
  port: number;
  database: string;
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
  user_beer_count: number;
  liked_count: number;
}

// Response of GET /admin-api/v1/images/:beverageId: a short-lived
// presigned GET URL for an approved private image, plus its expiry.
export interface PresignedImageResponse {
  url: string;
  expires_at: string;
}

// One row of GET /admin-api/v1/images/queue: a pending image candidate
// awaiting an approval decision. image_url is set only when the direct
// image locator is a public http(s) URL; has_private_image marks a
// private object that must be previewed through the preview-url
// endpoint. The raw storage key is never sent to the client.
export interface ImageQueueItem {
  id: number;
  beverage_id: number;
  beverage: Ref | null;
  brewery: Ref | null;
  source_type: string | null;
  source_url: string | null;
  license_type: string | null;
  attribution: string | null;
  license_url: string | null;
  status: string;
  source_check_status: "image" | "not_image" | "unreachable" | "unchecked" | string;
  source_content_type: string | null;
  source_checked_at: string | null;
  image_url: string | null;
  has_private_image: boolean;
  created_at?: string;
  updated_at?: string;
}

// One row of GET /admin-api/v1/images/decisions: an entry of the
// append-only approval audit trail.
export interface ImageReviewDecision {
  id: number;
  beverage_image_id: number;
  beverage_id: number;
  action: "approve" | "reject" | string;
  from_status: string;
  to_status: string;
  admin_user_id: number | null;
  admin_user_name: string | null;
  note: string | null;
  created_at: string;
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
  latitude: number;
  longitude: number;
  accuracy: string;
}

export interface BreweryDetail extends Brewery {
  geocode: Geocode | null;
  beers: ListResponse<Beer>;
}

export interface Category {
  id: number;
  cat_name?: string;
  name?: string;
  last_mod?: string;
  beer_count?: number;
  style_count?: number;
}

export interface CategoryDetail extends Category {
  styles: { id: number; style_name: string }[];
  beer_count: number;
  beers: ListResponse<Beer>;
}

export interface Style {
  id: number;
  style_name?: string;
  name?: string;
  last_mod?: string;
  category?: Ref | null;
  beer_count?: number;
}

export interface StyleDetail extends Style {
  category: Ref | null;
  beer_count: number;
  beers: ListResponse<Beer>;
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

export interface CollectionDetail extends Collection {
  beers?: ListResponse<CollectionBeerRow | Beer>;
  collection_beers?: ListResponse<CollectionBeerRow>;
  badge_holder_count: number;
}

export interface BeverageImage {
  id: number;
  beverage_id: number;
  beer?: Ref | null;
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
  beer_count: number;
  badge_count: number;
}

export interface UserDetail extends AppUser {
  uid: string;
  updated_at?: string;
  beer_count: number;
  badge_count: number;
  friend_count?: number;
  notification_count?: number;
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
  other_user: { id: number; user_name: string };
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
