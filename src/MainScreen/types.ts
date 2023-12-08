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
