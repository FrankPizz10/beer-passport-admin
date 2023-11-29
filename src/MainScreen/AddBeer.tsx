import React, { useState } from "react";
import "./SignInForm.css";
import { CreateBeer } from "./types";
import { auth } from "../Firebase/firebase";

const initialBeerValues: CreateBeer = {
  name: "",
  descript: "",
};

const AddBeer = () => {
  const [errorMessage, setErrorMessage] = useState("");
  const [beer, setBeer] = useState<CreateBeer>(initialBeerValues);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setBeer({
      ...beer,
      [name]: value,
    });
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const addBeerUrl = `${process.env.REACT_APP_API_URL}/admin/beers`;
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch(addBeerUrl, {
        method: "POST",
        body: JSON.stringify(beer),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const beerResponse = await response.json();
      console.log(beerResponse);
    } catch (error: unknown) {
        if (error instanceof Error) {
            setErrorMessage(error.message);
        }
      console.log(error);
    }
  };

  return (
    <div className="AddBeerContainer">
      <h1 className="Title">Add Beer</h1>
      <form className="AddBeerForm" onSubmit={handleSubmit}>
        <label className="BeerName">
          Beer Name:
          <input
            type="text"
            name="name"
            value={beer.name}
            onChange={handleInputChange}
          />
        </label>
        <label className="BreweryId">
          Brewery Id:
          <input
            type="text"
            name="brewery_id"
            value={beer.brewery_id}
            onChange={handleInputChange}
          />
        </label>
        <label className="CatId">
          Category Id:
          <input
            type="text"
            name="cat_id"
            value={beer.cat_id}
            onChange={handleInputChange}
          />
        </label>
        <label className="StyleId">
          Style Id:
          <input
            type="text"
            name="style_id"
            value={beer.style_id}
            onChange={handleInputChange}
          />
        </label>
        <label className="BeerABV">
          ABV:
          <input
            type="text"
            name="abv"
            value={beer.abv}
            onChange={handleInputChange}
          />
        </label>
        <label className="BeerIBU">
          IBU:
          <input
            type="text"
            name="ibu"
            value={beer.ibu}
            onChange={handleInputChange}
          />
        </label>
        <label className="BeerSRM">
          SRM:
          <input
            type="text"
            name="srm"
            value={beer.srm}
            onChange={handleInputChange}
          />
        </label>
        <label className="BeerUPC">
          UPC:
          <input
            type="text"
            name="upc"
            value={beer.upc}
            onChange={handleInputChange}
          />
        </label>
        <label className="BeerDescript">
          Description:
          <input
            type="text"
            name="descript"
            value={beer.descript}
            onChange={handleInputChange}
          />
        </label>
        <div className="SignInButton">
          <input type="submit" value="Add Beer" />
        </div>
        {errorMessage && <p className="ErrorMessage">{errorMessage}</p>}
      </form>
    </div>
  );
};

export default AddBeer;
