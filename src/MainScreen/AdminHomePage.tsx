// React functional component
import React, { useState } from "react";
import "./SignInForm.css";
import MakeAdminForm from "./MakeAdminForm";
import { auth } from "../Firebase/firebase";
import { useNavigate } from "react-router-dom";

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
    <>
      <MakeAdminForm />
      <div className="LogoutButton">
        <button onClick={handleLogout}>Logout</button>
      </div>
    </>
  );
}

export default AdminHomePage;
