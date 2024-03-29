import React, { useEffect, useState } from "react";
import "./SignInForm.css";
import { CreateBeer } from "./types";
import { auth } from "../Firebase/firebase";

const initialBeerValues: CreateBeer = {
  id: -1,
  name: "",
  brewery_id: -1,
  cat_id: -1,
  style_id: -1,
  abv: -1,
  descript: "",
};

const BeerForm = (beerFormProps: {action: string}) => {
  const [message, setMessage] = useState("");
  const [beer, setBeer] = useState<CreateBeer>(initialBeerValues);
  const [editBeer, setEditBeer] = useState<boolean>(false);

  useEffect(() => {
    setBeer(initialBeerValues);
    setEditBeer(false);
  }, [beerFormProps.action]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setBeer({
      ...beer,
      [name]: value,
    });
  };

  const handleGetBeer = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const beersUrl = `${process.env.REACT_APP_API_URL}/api/beers/${beer.id}`;
    const token = await auth.currentUser?.getIdToken();
    const response = await fetch(beersUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
    });
    const beerResponse = await response.json();
    console.log(beerResponse);
    if (beerResponse.id) {
      setBeer(beerResponse);
      setEditBeer(true);
    }
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    console.log(beer);
    const beersUrl = `${process.env.REACT_APP_API_URL}/admin/beers`;
    const token = await auth.currentUser?.getIdToken();
    const addBeer = async () => {
      const response = await fetch(beersUrl, {
        method: "POST",
        body: JSON.stringify(beer),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const beerResponse = await response.json();
      console.log(beerResponse);
      return beerResponse;
    }
    const updateBeer = async () => {
      const response = await fetch(beersUrl + `/${beer.id}`, {
        method: "PUT",
        body: JSON.stringify(beer),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const beerResponse = await response.json();
      console.log(beerResponse);
      return beerResponse;
    }
    const deleteBeer = async () => {
      const response = await fetch(beersUrl + `/${beer.id}`, {
        method: "DELETE",
        body: JSON.stringify(beer),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const beerResponse = await response.json();
      console.log(beerResponse);
      return beerResponse;
    }
    try {
      switch (beerFormProps.action) {
        case "add":
          const addRes = await addBeer();
          if (addRes.id) {
            setMessage(`Success: Added beer ${addRes.name} with id ${addRes.id}`);
          }
          break;
        case "update":
          let updateRes = await updateBeer();
          if (updateRes.id) {
            setMessage(`Success: Updated beer ${updateRes.name} with id ${updateRes.id}`);
          }
          break;
        case "delete":
          const deleteRes = await deleteBeer();
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
      <h1 className="Title">{beerFormProps.action.charAt(0).toUpperCase() + beerFormProps.action.slice(1)} Beer</h1>
      {beerFormProps.action === "update" &&
        <form className="AddBeerForm" onSubmit={handleGetBeer}>
          <label className="BeerId">
            Beer Id:
            <input
              type="text"
              name="id"
              value={beer.id}
              onChange={handleInputChange}
            />
          </label>
          <div className="SignInButton">
            <input type="submit" value="Edit" />
          </div>
        </form>
      }
      {(editBeer || (beerFormProps.action !== "update")) &&
        <form className="AddBeerForm" onSubmit={handleSubmit}>
          {beerFormProps.action !== "add" &&
            <label className="BeerId">
              Beer Id:
              <input
                type="text"
                name="id"
                value={beer.id}
                onChange={handleInputChange}
              />
            </label>
          }
          {beerFormProps.action !== "delete" &&
            <>
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
              <label className="BeerDescript">
                Description:
                <input
                  type="text"
                  name="descript"
                  value={beer.descript}
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
      }
    </div>
  );
};

export default BeerForm;
