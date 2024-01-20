import React, { useState } from "react";
import "./SignInForm.css";
import { CreateCategory } from "./types";
import { auth } from "../Firebase/firebase";

const initialCategoryValues: CreateCategory = {
    id: -1,
    cat_name: "",
};

const CategoryForm = (categoryFormProps: {action: string}) => {
  const [errorMessage, setErrorMessage] = useState("");
  const [category, setCategory] = useState<CreateCategory>(initialCategoryValues);
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setCategory({
      ...category,
      [name]: value,
    });
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    console.log(category);
    const addCategoryUrl = `${process.env.REACT_APP_API_URL}/admin/categories`;
    const token = await auth.currentUser?.getIdToken();
    const addCategory = async () => {
      const response = await fetch(addCategoryUrl, {
        method: "POST",
        body: JSON.stringify(category),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const categoryResponse = await response.json();
      console.log(categoryResponse);
      return categoryResponse;
    }
    const updateCategory = async () => {
      const response = await fetch(addCategoryUrl + `/${category.id}`, {
        method: "PUT",
        body: JSON.stringify(category),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const categoryResponse = await response.json();
      console.log(categoryResponse);
      return categoryResponse;
    }
    const deleteCategory = async () => {
      const response = await fetch(addCategoryUrl + `/${category.id}`, {
        method: "DELETE",
        body: JSON.stringify(category),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
      });
      const categoryResponse = await response.json();
      console.log(categoryResponse);
      return categoryResponse;
    }
    try {
      switch (categoryFormProps.action) {
        case "add":
          await addCategory();
          break;
        case "update":
          await updateCategory();
          break;
        case "delete":
          await deleteCategory();
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
      <h1 className="Title">{categoryFormProps.action.charAt(0).toUpperCase() + categoryFormProps.action.slice(1)} Category</h1>
      <form className="AddBeerForm" onSubmit={handleSubmit}>
        {(categoryFormProps.action === "delete" || categoryFormProps.action === "update") &&
            <label className="BeerId">
                ID:
                <input
                type="text"
                name="id"
                value={category.id}
                onChange={handleInputChange}
                />
            </label>
        }
        {categoryFormProps.action !== "delete" &&
          <>
            <label className="BeerName">
                Name:
                <input
                    type="text"
                    name="cat_name"
                    value={category.cat_name}
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

export default CategoryForm;
