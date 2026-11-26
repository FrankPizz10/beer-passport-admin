// Allowlist select objects, one module for every model (plan section 7).
// Handlers may only query through these projections. Lists select fewer
// fields than details.
// FORBIDDEN everywhere: users notification_token, api_keys key column, and
// the beers search_vector column (an Unsupported tsvector type that cannot
// be selected through Prisma anyway).
// The users list projection excludes uid; the user detail projection is the
// only one that includes uid and email, per plan section 7.

export const beerListSelect = {
  id: true,
  brewery_id: true,
  name: true,
  cat_id: true,
  style_id: true,
  abv: true,
  ibu: true,
  srm: true,
  discontinued: true,
  last_mod: true,
  brewery: { select: { id: true, name: true } },
  style: { select: { id: true, style_name: true } },
  category: { select: { id: true, cat_name: true } },
} as const;

export const beerDetailSelect = {
  id: true,
  brewery_id: true,
  name: true,
  cat_id: true,
  style_id: true,
  abv: true,
  ibu: true,
  srm: true,
  upc: true,
  descript: true,
  discontinued: true,
  last_mod: true,
  brewery: { select: { id: true, name: true } },
  style: { select: { id: true, style_name: true } },
  category: { select: { id: true, cat_name: true } },
} as const;

export const breweryListSelect = {
  id: true,
  name: true,
  city: true,
  state: true,
  country: true,
  last_mod: true,
  _count: { select: { beers: { where: { archived_at: null } } } },
} as const;

export const breweryDetailSelect = {
  id: true,
  name: true,
  address1: true,
  address2: true,
  city: true,
  state: true,
  code: true,
  country: true,
  phone: true,
  website: true,
  descript: true,
  add_user: true,
  last_mod: true,
} as const;

export const categoryListSelect = {
  id: true,
  cat_name: true,
  last_mod: true,
  _count: { select: { beers: { where: { archived_at: null } }, styles: { where: { archived_at: null } } } },
} as const;

export const categoryDetailSelect = {
  id: true,
  cat_name: true,
  last_mod: true,
} as const;

export const styleListSelect = {
  id: true,
  cat_id: true,
  style_name: true,
  last_mod: true,
  category: { select: { id: true, cat_name: true } },
  _count: { select: { beers: { where: { archived_at: null } } } },
} as const;

export const styleDetailSelect = {
  id: true,
  cat_id: true,
  style_name: true,
  last_mod: true,
  category: { select: { id: true, cat_name: true } },
} as const;

export const collectionListSelect = {
  id: true,
  name: true,
  difficulty: true,
  description: true,
  created_at: true,
  updated_at: true,
  _count: { select: { collection_beers: true, user_badges: true } },
} as const;

export const collectionDetailSelect = {
  id: true,
  name: true,
  difficulty: true,
  description: true,
  created_at: true,
  updated_at: true,
} as const;

export const collectionBeerListSelect = {
  id: true,
  collection_id: true,
  beer_id: true,
  created_at: true,
  updated_at: true,
  collections: { select: { id: true, name: true } },
  beers: { select: { id: true, name: true } },
} as const;

export const collectionBeerDetailSelect = collectionBeerListSelect;

export const beverageImageListSelect = {
  id: true,
  beverage_id: true,
  source_type: true,
  source_url: true,
  storage_key: true,
  license_type: true,
  attribution: true,
  license_url: true,
  status: true,
  verified_at: true,
  reviewed_by: true,
  reviewed_by_uid: true,
  reviewed_at: true,
  source_content_type: true,
  source_checked_at: true,
  source_check_status: true,
  created_at: true,
  updated_at: true,
} as const;

export const beverageImageDetailSelect = beverageImageListSelect;

// Server-side only: the private-image endpoint needs the storage key to
// sign a presigned GET URL. The key is never serialized into a response;
// this select exists so the endpoint does not load the full row.
export const beverageImageStorageSelect = {
  id: true,
  storage_key: true,
};

// Server-side only: the pending-image preview endpoint needs the row's
// status and storage key. The key is never serialized into a response.
export const beverageImagePreviewSelect = {
  id: true,
  status: true,
  storage_key: true,
} as const;

// Server-side only, for the approval queue and the per-row preview
// endpoint: like the storage select above, storage_key is loaded only
// so the handler can derive image_url (when the key is an http(s) URL)
// and has_private_image (when it is a bare private key). The serializer
// in routes/images.ts never emits the key itself.
export const beverageImageQueueSelect = {
  id: true,
  beverage_id: true,
  source_type: true,
  source_url: true,
  storage_key: true,
  license_type: true,
  attribution: true,
  license_url: true,
  status: true,
  verified_at: true,
  reviewed_by: true,
  reviewed_by_uid: true,
  reviewed_at: true,
  source_content_type: true,
  source_checked_at: true,
  source_check_status: true,
  created_at: true,
  updated_at: true,
  beers: {
    select: {
      id: true,
      name: true,
      brewery: { select: { id: true, name: true } },
    },
  },
} as const;

// The decision audit trail. admin_uid is deliberately NOT selected for
// API responses (the users list projection excludes uid for the same
// reason); who decided is reported as the decider's users row id plus
// user_name through the admin_user relation.
export const imageReviewEventListSelect = {
  id: true,
  beverage_image_id: true,
  beverage_id: true,
  action: true,
  from_status: true,
  to_status: true,
  admin_user_id: true,
  note: true,
  created_at: true,
  admin_user: { select: { id: true, user_name: true } },
} as const;

export const breweryGeocodeSelect = {
  id: true,
  brewery_id: true,
  latitude: true,
  longitude: true,
  accuracy: true,
} as const;

export const userListSelect = {
  id: true,
  age: true,
  email: true,
  user_name: true,
  private: true,
  created_at: true,
  updated_at: true,
  _count: { select: { user_beers: true, user_badges: true } },
} as const;

export const userDetailSelect = {
  id: true,
  uid: true,
  age: true,
  email: true,
  user_name: true,
  private: true,
  created_at: true,
  updated_at: true,
  _count: { select: { user_beers: true, user_badges: true, notifications: true } },
} as const;

export const userBeerListSelect = {
  id: true,
  user_id: true,
  beer_id: true,
  liked: true,
  created_at: true,
  updated_at: true,
  beers: { select: { id: true, name: true } },
} as const;

export const userBeerDetailSelect = userBeerListSelect;

export const userBadgeListSelect = {
  id: true,
  user_id: true,
  collection_id: true,
  earned: true,
  progress: true,
  created_at: true,
  updated_at: true,
  collections: { select: { id: true, name: true } },
} as const;

export const userBadgeDetailSelect = userBadgeListSelect;

export const friendListSelect = {
  id: true,
  user_1: true,
  user_2: true,
  created_at: true,
  updated_at: true,
  users_friends_user_1Tousers: { select: { id: true, user_name: true } },
  users_friends_user_2Tousers: { select: { id: true, user_name: true } },
} as const;

export const friendDetailSelect = friendListSelect;

export const notificationListSelect = {
  id: true,
  user_id: true,
  type: true,
  message: true,
  viewed: true,
  created_at: true,
  updated_at: true,
} as const;

export const notificationDetailSelect = notificationListSelect;

export const apiKeyListSelect = {
  id: true,
  name: true,
  revoked: true,
  created_at: true,
  last_used_at: true,
  last_mod: true,
} as const;

export const apiKeyDetailSelect = apiKeyListSelect;

// Registry used by the projection tests and by reviewers.
export const projections = {
  beersList: beerListSelect,
  beersDetail: beerDetailSelect,
  breweriesList: breweryListSelect,
  breweriesDetail: breweryDetailSelect,
  categoriesList: categoryListSelect,
  categoriesDetail: categoryDetailSelect,
  stylesList: styleListSelect,
  stylesDetail: styleDetailSelect,
  collectionsList: collectionListSelect,
  collectionsDetail: collectionDetailSelect,
  collection_beersList: collectionBeerListSelect,
  collection_beersDetail: collectionBeerDetailSelect,
  beverage_imagesList: beverageImageListSelect,
  beverage_imagesDetail: beverageImageDetailSelect,
  beverage_imagesQueue: beverageImageQueueSelect,
  beverage_imagesPreview: beverageImagePreviewSelect,
  image_review_eventsList: imageReviewEventListSelect,
  breweries_geocodeList: breweryGeocodeSelect,
  breweries_geocodeDetail: breweryGeocodeSelect,
  usersList: userListSelect,
  usersDetail: userDetailSelect,
  user_beersList: userBeerListSelect,
  user_beersDetail: userBeerDetailSelect,
  user_badgesList: userBadgeListSelect,
  user_badgesDetail: userBadgeDetailSelect,
  friendsList: friendListSelect,
  friendsDetail: friendDetailSelect,
  notificationsList: notificationListSelect,
  notificationsDetail: notificationDetailSelect,
  api_keysList: apiKeyListSelect,
  api_keysDetail: apiKeyDetailSelect,
};
