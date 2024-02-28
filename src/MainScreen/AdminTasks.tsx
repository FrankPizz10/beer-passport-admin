import React, { useState } from 'react';
import './AdminTasks.css';
import { auth } from "../Firebase/firebase";

const SheetsPage = () => {
  const [apiKey, setApiKey] = useState<string>("");

  const handleGenerateClick = async () => {
    const token = await auth.currentUser?.getIdToken();
    const response = await fetch(`${process.env.REACT_APP_API_URL}/admin/apikey`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
    });
    const apiKeyResponse = await response.json();
    setApiKey(apiKeyResponse.apiKey);
  }

  const handleGetCategories = async () => {
    console.log("categories");
    const response = await fetch(`${process.env.REACT_APP_API_URL}/secure/api/categories`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      }
    });
    const categories = await response.json();
    console.log(categories);
  }

  const handleGetStyles = async () => {
    console.log("styles");
    const response = await fetch(`${process.env.REACT_APP_API_URL}/secure/api/styles`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      }
    });
    const styles = await response.json();
    console.log(styles);
  }

  const handleGetBreweries = async () => {
    console.log("breweries");
    const response = await fetch(`${process.env.REACT_APP_API_URL}/secure/api/breweries`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      }
    });
    const breweries = await response.json();
    console.log(breweries);
  }

  const handleGetBeers = async () => {
    console.log("beers");
    const response = await fetch(`${process.env.REACT_APP_API_URL}/secure/api/beers`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      }
    });
    const beers = await response.json();
    console.log(beers);
  }

  return (
    <div className='sheetsMain'>
      <button className='sheetsButton' onClick={handleGenerateClick}>Generate API Key</button>
      <p className='apiKey'>{apiKey}</p>
      <form className='categories'>
        <label className='sheetsLabel'>
          API_KEY
          <input
              className='sheetsInput'
              type="text"
              name="id"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
        </label>
        <div className="getCategories">
          <button className="sheetsButton" type="button" onClick={handleGetCategories}>Get Categories</button>
        </div>
        <div className="getCategories">
          <button className="sheetsButton" type="button" onClick={handleGetStyles}>Get Styles</button>
        </div>
        <div className="getCategories">
          <button className="sheetsButton" type="button" onClick={handleGetBreweries}>Get Breweries</button>
        </div>
        <div className="getCategories">
          <button className="sheetsButton" type="button" onClick={handleGetBeers}>Get Beers</button>
        </div>
      </form>
    </div>
  );
};

export default SheetsPage;