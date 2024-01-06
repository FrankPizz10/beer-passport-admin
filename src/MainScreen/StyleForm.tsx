import React, { useState } from "react";
import "./SignInForm.css";
import { CreateStyle } from "./types";
import { auth } from "../Firebase/firebase";

const initialStyleValues: CreateStyle = {
    id: -1,
    cat_id: 11,
    style_name: "",
};

const StyleForm = (styleFormProps: {action: string}) => {
  const [errorMessage, setErrorMessage] = useState("");
  const [style, setStyle] = useState<CreateStyle>(initialStyleValues);
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setStyle({
      ...style,
      [name]: value,
    });
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    console.log(style);
    const addStyleUrl = `${process.env.REACT_APP_API_URL}/admin/styles`;
    const token = await auth.currentUser?.getIdToken();
    const addStyle = async () => {
      const response = await fetch(addStyleUrl, {
        method: "POST",
        body: JSON.stringify(style),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const styleResponse = await response.json();
      console.log(styleResponse);
      return styleResponse;
    }
    const updateStyle = async () => {
      const response = await fetch(addStyleUrl + `/${style.id}`, {
        method: "PUT",
        body: JSON.stringify(style),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const styleResponse = await response.json();
      console.log(styleResponse);
      return styleResponse;
    }
    const deleteStyle = async () => {
      const response = await fetch(addStyleUrl + `/${style.id}`, {
        method: "DELETE",
        body: JSON.stringify(style),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const styleResponse = await response.json();
      console.log(styleResponse);
      return styleResponse;
    }
    try {
      switch (styleFormProps.action) {
        case "add":
          await addStyle();
          break;
        case "update":
          await updateStyle();
          break;
        case "delete":
          await deleteStyle();
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
      <h1 className="Title">{styleFormProps.action.charAt(0).toUpperCase() + styleFormProps.action.slice(1)} Style</h1>
      <form className="AddBeerForm" onSubmit={handleSubmit}>
        {(styleFormProps.action === "delete" || styleFormProps.action === "update") &&
            <label className="BeerId">
                ID:
                <input
                type="text"
                name="id"
                value={style.id}
                onChange={handleInputChange}
                />
            </label>
        }
        {styleFormProps.action !== "delete" &&
          <>
            <label className="BeerName">
                CAT ID:
                <input
                    type="text"
                    name="cat_id"
                    value={style.cat_id}
                    onChange={handleInputChange}
                />
            </label>
            <label className="BreweryId">
              Style Name:
              <input
                type="text"
                name="style_name"
                value={style.style_name}
                onChange={handleInputChange}
              />
            </label>
          </>
        }
        <div className="SignInButton">
          <input type="submit" value="Submit" />
        </div>
        {errorMessage && <p className="ErrorMessage">{errorMessage}</p>}
      </form>
    </div>
  );
};

export default StyleForm;
