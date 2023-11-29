export interface CreateBeer {
  brewery_id: number;
  name: string;
  cat_id: number;
  style_id: number;
  abv?: number;
  ibu?: number;
  srm?: number;
  upc?: number;
  filepath?: string;
  descript: string;
  collection_id?: number;
}

export interface CreateCollection {
  name: string;
  difficulty: number;
  description: string;
}

export interface CreateCollectionBeer {
  collection_id: number;
  beer_id: number;
}
