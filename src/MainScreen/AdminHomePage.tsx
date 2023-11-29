// React functional component
import React, { useState } from "react";
import "./AdminHomePage.css"
import MakeAdminForm from "./MakeAdminForm";
import { auth } from "../Firebase/firebase";
import { useLocation, useNavigate } from "react-router-dom";
import AddBeer from "./AddBeer";
import AddCollection from "./AddCollection";
import AddCollectionBeer from "./AddCollectionBeer";

interface AdminHomePageProps {
  user: string;
}

const AdminHomePage: React.FC<AdminHomePageProps> = ({user}) => {
  let navigate = useNavigate();
  const [adminTask, setAdminTask] = useState("");

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
        <button className="AdminButton" onClick={() => setAdminTask("AddBeer")}>
          Add Beer
        </button>
        <button className="AdminButton" onClick={() => setAdminTask("AddCollection")}>
          Add Collection
        </button>
        <button className="AdminButton" onClick={() => setAdminTask("AddCollectionBeer")}>
          Add Collection Beer
        </button>
      </div>
      {adminTask === "MakeAdmin" && <MakeAdminForm />}
      {adminTask === "AddBeer" && <AddBeer />}
      {adminTask === "AddCollection" && <AddCollection />}
      {adminTask === "AddCollectionBeer" && <AddCollectionBeer />}
      <div className="LogoutButton">
        <button onClick={handleLogout}>Logout</button>
      </div>
    </div>
  );
};

export default AdminHomePage;
