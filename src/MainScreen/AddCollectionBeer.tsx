import React, { useState } from "react";
import "./SignInForm.css";
import { CreateCollectionBeer } from "./types";
import { auth } from "../Firebase/firebase";

const AddCollectionBeer = () => {
  const [errorMessage, setErrorMessage] = useState("");
  const [collectionBeer, setCollectionBeer] = useState<CreateCollectionBeer>({} as CreateCollectionBeer);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setCollectionBeer({
      ...collectionBeer,
      [name]: value,
    });
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const addCollectionUrl = `${process.env.REACT_APP_API_URL}/admin/collections/addBeer`;
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch(addCollectionUrl, {
        method: "POST",
        body: JSON.stringify(collectionBeer),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const collectionBeerResponse = await response.json();
      console.log(collectionBeerResponse);
    } catch (error: unknown) {
        if (error instanceof Error) {
            setErrorMessage(error.message);
        }
      console.log(error);
    }
  };

  return (
    <div className="AddBeerContainer">
      <h1 className="Title">Add Collection Beer</h1>
      <form className="AddBeerForm" onSubmit={handleSubmit}>
        <label className="BeerName">
          Collection ID:
          <input
            type="text"
            name="collection_id"
            value={collectionBeer.collection_id}
            onChange={handleInputChange}
          />
        </label>
        <label className="BreweryId">
          Beer ID:
          <input
            type="text"
            name="beer_id"
            value={collectionBeer.beer_id}
            onChange={handleInputChange}
          />
        </label>
        <div className="SignInButton">
          <input type="submit" value="Add Collection Beer" />
        </div>
        {errorMessage && <p className="ErrorMessage">{errorMessage}</p>}
      </form>
    </div>
  );
};

export default AddCollectionBeer;