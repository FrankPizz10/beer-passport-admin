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

export interface AddBeerToCollection {
  beer_id: number;
  collection_id: number;
}
