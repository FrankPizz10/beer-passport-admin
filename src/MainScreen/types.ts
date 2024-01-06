export interface CreateBeer {
  id: number
  brewery_id?: number;
  name: string;
  cat_id?: number;
  style_id?: number;
  abv?: number | undefined;
  ibu?: number | undefined;
  srm?: number | undefined;
  upc?: number | undefined;
  descript?: string;
}

export interface CreateCollection {
  name: string;
  difficulty: number;
  description: string;
}

export interface CreateCollectionBeer {
  beer_id: number;
  collection_id: number;
}

export interface CreateBrewery {
  id: number;
  name: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  code?: string;
  country?: string;
  phone?: string;
  website?: string;
  descript?: string;
}

export interface CreateStyle {
  id: number;
  cat_id?: number;
  style_name: string;
}

export interface CreateCategory {
  id: number;
  cat_name: string;
}
