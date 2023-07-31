// React functional component
import React, { useState } from "react";
import "./SignInForm.css";
import MakeAdminForm from "./MakeAdminForm";
import { auth } from "../Firebase/firebase";
import { useNavigate } from "react-router-dom";
import AddBeer from "./AddBeer";

function AdminHomePage() {
  let navigate = useNavigate();

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
      <MakeAdminForm />
      <AddBeer />
      <div className="LogoutButton">
        <button onClick={handleLogout}>Logout</button>
      </div>
    </div>
  );
}

export default AdminHomePage;
