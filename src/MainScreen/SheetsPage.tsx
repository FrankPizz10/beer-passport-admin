import React, { useEffect, useState } from 'react';
import './SheetsPage.css';

const SheetsPage = () => {
  const [apiKey, setApiKey] = useState<string>("");

  const handleGenerateClick = async () => {
    const response = await fetch(`${process.env.REACT_APP_API_URL}/apikey`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });
    const apiKeyResponse = await response.json();
    setApiKey(apiKeyResponse.apiKey);
  }

  const handleGetCategories = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
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

  return (
    <div>
      <button onClick={handleGenerateClick}>Generate API Key</button>
      <p className='apiKey'>{apiKey}</p>
      <form className='categories' onSubmit={handleGetCategories}>
        <label>
          API_KEY
          <input
              type="text"
              name="id"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
        </label>
        <div className="getCategories">
            <input type="submit" value="Get Categories" />
        </div>
      </form>
    </div>
  );
};

export default SheetsPage;