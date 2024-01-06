// React functional component
import React, { useState } from "react";
import "./AdminHomePage.css"
import MakeAdminForm from "./MakeAdminForm";
import { auth } from "../Firebase/firebase";
import { useLocation, useNavigate } from "react-router-dom";
import BeerForm from "./BeerForm";
import CollectionForm from "./CollectionForm";
import CollectionBeerForm from "./CollectionBeerForm";
import BreweryForm from "./BreweryForm";
import CategoryForm from "./CategoryForm";
import StyleForm from "./StyleForm";

interface AdminHomePageProps {
  user: string;
}

const AdminHomePage: React.FC<AdminHomePageProps> = ({user}) => {
  let navigate = useNavigate();
  const [adminTask, setAdminTask] = useState("");
  const [action, setAction] = useState("");

  const { state } = useLocation();
  const username = state?.user;

  const handleLogout = () => {
    auth
      .signOut()
      .then(() => {
        navigate("/");
      })
      .catch((error) => {
        console.log(error);
      });
  };

  return (
    <div className="Main">
      <h1 className="Title">Admin Home Page</h1>
      <h2 className="AdminWelcome">Welcome {username}</h2>
      <div className="AdminTasks">
        <button className="AdminButton" onClick={() => setAdminTask("MakeAdmin")}>
            Make Admin
        </button>
      </div>
      <div className="AdminTasks">
        <button className="AdminButton" onClick={() => setAction("add")}>
          Add
        </button>
        <button className="AdminButton" onClick={() => setAction("update")}>
          Update
        </button>
        <button className="AdminButton" onClick={() => setAction("delete")}>
          Delete
        </button>
      </div>
      <div className="AdminTasks">
        <button className="AdminButton" onClick={() => setAdminTask("AddBeer")}>
          {action.charAt(0).toUpperCase() + action.slice(1)} Beer
        </button>
        <button className="AdminButton" onClick={() => setAdminTask("AddCollection")}>
        {action.charAt(0).toUpperCase() + action.slice(1)} Collection
        </button>
        {action !== "update" && 
          <button className="AdminButton" onClick={() => setAdminTask("AddCollectionBeer")}>
            {action.charAt(0).toUpperCase() + action.slice(1)} Collection Beer
          </button>
        }
        <button className="AdminButton" onClick={() => setAdminTask("AddBrewery")}>
          {action.charAt(0).toUpperCase() + action.slice(1)} Brewery
        </button>
        <button className="AdminButton" onClick={() => setAdminTask("AddCategory")}>
          {action.charAt(0).toUpperCase() + action.slice(1)} Category
        </button>
        <button className="AdminButton" onClick={() => setAdminTask("AddStyle")}>
          {action.charAt(0).toUpperCase() + action.slice(1)} Style
        </button>
      </div>
      {adminTask === "MakeAdmin" && <MakeAdminForm />}
      {adminTask === "AddBeer" && <BeerForm action={action}/>}
      {adminTask === "AddCollection" && <CollectionForm action={action}/>}
      {adminTask === "AddCollectionBeer" && <CollectionBeerForm action={action}/>}
      {adminTask === "AddBrewery" && <BreweryForm action={action}/>}
      {adminTask === "AddCategory" && <CategoryForm action={action}/>}
      {adminTask === "AddStyle" && <StyleForm action={action}/>}
      <div className="LogoutButton">
        <button onClick={handleLogout}>Logout</button>
      </div>
    </div>
  );
};

export default AdminHomePage;
