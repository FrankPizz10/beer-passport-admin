import React, { useState } from "react";
import "./SignInForm.css";
import { CreateCollection } from "./types";
import { auth } from "../Firebase/firebase";

const initialCollectionValues: CreateCollection = {
    name: "",
    difficulty: 1,
    description: "",
};

const AddCollection = () => {
  const [errorMessage, setErrorMessage] = useState("");
  const [collection, setCollection] = useState<CreateCollection>(initialCollectionValues);
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setCollection({
      ...collection,
      [name]: value,
    });
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const addCollectionUrl = `${process.env.REACT_APP_API_URL}/admin/collections`;
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch(addCollectionUrl, {
        method: "POST",
        body: JSON.stringify(collection),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const collectionResponse = await response.json();
      console.log(collectionResponse);
    } catch (error: unknown) {
        if (error instanceof Error) {
            setErrorMessage(error.message);
        }
      console.log(error);
    }
  };

  return (
    <div className="AddBeerContainer">
      <h1 className="Title">Add Collection</h1>
      <form className="AddBeerForm" onSubmit={handleSubmit}>
        <label className="BeerName">
          Name:
          <input
            type="text"
            name="name"
            value={collection.name}
            onChange={handleInputChange}
          />
        </label>
        <label className="BreweryId">
          Difficulty:
          <input
            type="text"
            name="difficulty"
            value={collection.difficulty}
            onChange={handleInputChange}
          />
        </label>
        <label className="CatId">
          Description:
          <input
            type="text"
            name="description"
            value={collection.description}
            onChange={handleInputChange}
          />
        </label>
        <div className="SignInButton">
          <input type="submit" value="Add Collection" />
        </div>
        {errorMessage && <p className="ErrorMessage">{errorMessage}</p>}
      </form>
    </div>
  );
};

export default AddCollection;
