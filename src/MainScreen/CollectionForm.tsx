import React, { useState } from "react";
import "./SignInForm.css";
import { CreateCollection } from "./types";
import { auth } from "../Firebase/firebase";

const initialCollectionValues: CreateCollection = {
    name: "",
    difficulty: 1,
    description: "",
};

const CollectionForm = (collectionFormProps: {action: string}) => {
  const [message, setMessage] = useState("");
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
    console.log(collection);
    const addCollectionUrl = `${process.env.REACT_APP_API_URL}/admin/collections`;
    const token = await auth.currentUser?.getIdToken();
    const getCollection = async () => {
      const getColelctionUrl = `${process.env.REACT_APP_API_URL}/api/collections/name/${collection.name}`;
      const fetchedCollection = await fetch(getColelctionUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const fetchedCollectionRes = await fetchedCollection.json();
      console.log("fetchedCollectionRes");
      console.log(fetchedCollectionRes);
      return fetchedCollectionRes;
    }
    const addCollection = async () => {
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
      return collectionResponse;
    }
    const updateCollection = async () => {
      const fetchedCollectionRes = await getCollection();
      const response = await fetch(addCollectionUrl + `/${fetchedCollectionRes.id}`, {
        method: "PUT",
        body: JSON.stringify({
          ...collection,
          id: fetchedCollectionRes.id,
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const collectionResponse = await response.json();
      console.log(collectionResponse);
      return collectionResponse;
    }
    const deleteCollection = async () => {
      const fetchedCollectionRes = await getCollection();
      const response = await fetch(addCollectionUrl + `/${fetchedCollectionRes.id}`, {
        method: "DELETE",
        body: JSON.stringify(collection),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const collectionResponse = await response.json();
      console.log(collectionResponse);
      return collectionResponse;
    }
    try {
      switch (collectionFormProps.action) {
        case "add":
          const addRes = await addCollection();
          if (addRes.id) {
            setMessage(`Success: Added collection ${addRes.name} with id ${addRes.id}`);
          }
          break;
        case "update":
          const updateRes = await updateCollection();
          if (updateRes.id) {
            setMessage(`Success: Updated collection ${updateRes.name} with id ${updateRes.id}`);
          }
          break;
        case "delete":
          const deleteRes = await deleteCollection();
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
        if (error instanceof Error) {
            setMessage(error.message);
        }
      console.log(error);
    }
  };

  return (
    <div className="AddBeerContainer">
      <h1 className="Title">{collectionFormProps.action.charAt(0).toUpperCase() + collectionFormProps.action.slice(1)} Collection</h1>
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
        {collectionFormProps.action !== "delete" &&
          <>
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
          </>
        }
        <div className="SignInButton">
          <input type="submit" value="Submit" />
        </div>
        {message && <p className="ErrorMessage">{message}</p>}
      </form>
    </div>
  );
};

export default CollectionForm;
