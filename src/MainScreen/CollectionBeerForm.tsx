import React, { useState } from "react";
import "./SignInForm.css";
import { CreateCollectionBeer } from "./types";
import { auth } from "../Firebase/firebase";

const initialCollectionBeerValues: CreateCollectionBeer = {
  collection_id: -1,
  beer_id: -1,
};

const CollectionBeerForm = (collectionBeerFormProps: {action: string}) => {
  const [message, setMessage] = useState("");
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
          const addRes = await addCollectionBeer();
          if (addRes.id) {
            setMessage(`Success: Added beer ${addRes.name} with id ${addRes.id}`);
          }
          else {
            setMessage(`Error: ${addRes.Error}`);
          }
          break;
        case "delete":
          const deleteRes = await deleteCollectionBeer();
          if (deleteRes.id) {
            setMessage(`Success: Deleted beer ${deleteRes.id}`);
          }
          else {
            setMessage(`Error: ${deleteRes.Error}`);
          }
          break;
        default:
          break;
      }
    } catch (error: unknown) {
      console.log("error");
        if (error instanceof Error) {
            setMessage(error.message);
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
        {message && <p className="ErrorMessage">{message}</p>}
      </form>
    </div>
  );
};

export default CollectionBeerForm;
