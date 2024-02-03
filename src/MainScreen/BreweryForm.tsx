import React, { useState } from "react";
import "./SignInForm.css";
import { CreateBrewery } from "./types";
import { auth } from "../Firebase/firebase";

const initialBreweryValues: CreateBrewery = {
    id: -1,
    name: "",
    address1: "",
    address2: "",
    city: "",
    state: "",
    code: "",
    country: "",
    phone: "",
    website: "",
    descript: "",
};

const BreweryForm = (breweryFormProps: {action: string}) => {
  const [message, setMessage] = useState("");
  const [brewery, setBrewery] = useState<CreateBrewery>(initialBreweryValues);
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setBrewery({
      ...brewery,
      [name]: value,
    });
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    console.log(brewery);
    const addBreweryUrl = `${process.env.REACT_APP_API_URL}/admin/breweries`;
    const token = await auth.currentUser?.getIdToken();
    const addBrewery = async () => {
      const response = await fetch(addBreweryUrl, {
        method: "POST",
        body: JSON.stringify(brewery),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const breweryResponse = await response.json();
      console.log('breweryresponse', breweryResponse);
      return breweryResponse;
    }
    const updateBrewery = async () => {
      const response = await fetch(addBreweryUrl + `/${brewery.id}`, {
        method: "PUT",
        body: JSON.stringify(brewery),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const breweryResponse = await response.json();
      console.log(breweryResponse);
      return breweryResponse;
    }
    const deleteBrewery = async () => {
      const response = await fetch(addBreweryUrl + `/${brewery.id}`, {
        method: "DELETE",
        body: JSON.stringify(brewery),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const breweryResponse = await response.json();
      console.log(breweryResponse);
      return breweryResponse;
    }
    try {
      switch (breweryFormProps.action) {
        case "add":
          const addRes = await addBrewery();
          if (addRes.id) {
            setMessage(`Success: Added brewery ${addRes.name} with id ${addRes.id}`);
          }
          break;
        case "update":
          const updateRes = await updateBrewery();
          if (updateRes.id) {
            setMessage(`Success: Updated brewery ${updateRes.name} with id ${updateRes.id}`);
          }
          break;
        case "delete":
          const deleteRes = await deleteBrewery();
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
      <h1 className="Title">{breweryFormProps.action.charAt(0).toUpperCase() + breweryFormProps.action.slice(1)} Brewery</h1>
      <form className="AddBeerForm" onSubmit={handleSubmit}>
        {(breweryFormProps.action === "delete" || breweryFormProps.action === "update") &&
            <label className="BeerId">
                ID:
                <input
                type="text"
                name="id"
                value={brewery.id}
                onChange={handleInputChange}
                />
            </label>
        }
        {breweryFormProps.action !== "delete" &&
          <>
            <label className="BeerName">
                Name:
                <input
                    type="text"
                    name="name"
                    value={brewery.name}
                    onChange={handleInputChange}
                />
            </label>
            <label className="BreweryId">
              Address1:
              <input
                type="text"
                name="address1"
                value={brewery.address1}
                onChange={handleInputChange}
              />
            </label>
            <label className="CatId">
              Address2:
              <input
                type="text"
                name="address2"
                value={brewery.address2}
                onChange={handleInputChange}
              />
            </label>
            <label className="CatId">
              City:
              <input
                type="text"
                name="city"
                value={brewery.city}
                onChange={handleInputChange}
              />
            </label>
            <label className="CatId">
              State:
              <input
                type="text"
                name="state"
                value={brewery.state}
                onChange={handleInputChange}
              />
            </label>
            <label className="CatId">
              Code:
              <input
                type="text"
                name="code"
                value={brewery.code}
                onChange={handleInputChange}
              />
            </label>
            <label className="CatId">
              Country:
              <input
                type="text"
                name="country"
                value={brewery.country}
                onChange={handleInputChange}
              />
            </label>
            <label className="CatId">
              Phone:
              <input
                type="text"
                name="phone"
                value={brewery.phone}
                onChange={handleInputChange}
              />
            </label>
            <label className="CatId">
              Website:
              <input
                type="text"
                name="website"
                value={brewery.website}
                onChange={handleInputChange}
              />
            </label>
            <label className="CatId">
              Description:
              <input
                type="text"
                name="descript"
                value={brewery.descript}
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

export default BreweryForm;
