import React, { useState } from "react";
import "./SignInForm.css";
import { CreateCollectionBeer } from "./types";
import { auth } from "../Firebase/firebase";

const initialAddBeerToCollectionValues: CreateCollectionBeer = {
  collection_id: -1,
  beer_id: -1,
};

const AddBeerToCollect = () => {
  const [errorMessage, setErrorMessage] = useState("");
  const [addBeerToColelction, setAddBeerToCollection] =
    useState<CreateCollectionBeer>(initialAddBeerToCollectionValues);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setAddBeerToCollection({
      ...addBeerToColelction,
      [name]: value,
    });
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const addBeerToCollectionUrl = `${process.env.REACT_APP_API_URL}/admin/collections/addBeer`;
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch(addBeerToCollectionUrl, {
        method: "POST",
        body: JSON.stringify({
          addBeerToColelction,
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const addBeerToCollectionResponse = await response.json();
      console.log(addBeerToCollectionResponse);
    } catch (error) {
      console.log(error);
    }
  };

  return (
    <div className="AddBeerContainer">
      <h1 className="Title">Add Beer To Collection</h1>
      <form className="AddBeerForm" onSubmit={handleSubmit}>
        <label className="BeerName">
          Colelction Id:
          <input
            type="text"
            name="collection_id"
            value={addBeerToColelction.collection_id}
            onChange={handleInputChange}
          />
        </label>
        <label className="BreweryId">
          Beer Id:
          <input
            type="text"
            name="beer_id"
            value={addBeerToColelction.beer_id}
            onChange={handleInputChange}
          />
        </label>
        <div className="SignInButton">
          <input type="submit" value="Add Beer To Collection" />
        </div>
        {errorMessage && <p className="ErrorMessage">{errorMessage}</p>}
      </form>
    </div>
  );
};

export default AddBeerToCollect;
