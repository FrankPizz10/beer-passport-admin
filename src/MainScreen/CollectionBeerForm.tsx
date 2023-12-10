import React, { useState } from "react";
import "./SignInForm.css";
import { CreateCollectionBeer } from "./types";
import { auth } from "../Firebase/firebase";

const initialCollectionBeerValues: CreateCollectionBeer = {
  collection_id: -1,
  beer_id: -1,
};

const CollectionBeerForm = (collectionBeerFormProps: {action: string}) => {
  const [errorMessage, setErrorMessage] = useState("");
  const [collectionBeer, setCollectionBeer] = useState<CreateCollectionBeer>(initialCollectionBeerValues);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setCollectionBeer({
      ...collectionBeer,
      [name]: value,
    });
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    console.log(collectionBeer);
    const addCollectionUrl = `${process.env.REACT_APP_API_URL}/admin/collections/addBeer`;
    const token = await auth.currentUser?.getIdToken();
    const addCollectionBeer = async () => {
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
      return collectionBeerResponse;
    }
    const updateCollectionBeer = async () => {
      const response = await fetch(addCollectionUrl, {
        method: "PUT",
        body: JSON.stringify(collectionBeer),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const collectionBeerResponse = await response.json();
      console.log(collectionBeerResponse);
      return collectionBeerResponse;
    }
    const deleteCollectionBeer = async () => {
      const response = await fetch(`${process.env.REACT_APP_API_URL}/admin/collections/deleteBeer`, {
        method: "DELETE",
        body: JSON.stringify(collectionBeer),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const collectionBeerResponse = await response.json();
      console.log(collectionBeerResponse);
      return collectionBeerResponse;
    }
    try {
      switch (collectionBeerFormProps.action) {
        case "add":
          await addCollectionBeer();
          break;
        case "update":
          await updateCollectionBeer();
          break;
        case "delete":
          await deleteCollectionBeer();
          break;
        default:
          break;
      }
    } catch (error: unknown) {
        if (error instanceof Error) {
            setErrorMessage(error.message);
        }
      console.log(error);
    }
  };

  return (
    <div className="AddBeerContainer">
      <h1 className="Title">{collectionBeerFormProps.action.charAt(0).toUpperCase() + collectionBeerFormProps.action.slice(1)} Collection Beer</h1>
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
          <input type="submit" value="Submit" />
        </div>
        {errorMessage && <p className="ErrorMessage">{errorMessage}</p>}
      </form>
    </div>
  );
};

export default CollectionBeerForm;
