// React functional component
import React, { useState } from "react";
import "./SignInForm.css";
import { functions } from "../Firebase/firebase";
import { httpsCallable } from "@firebase/functions";

function MakeAdminForm() {
  const [email, setEmail] = useState("");

  const handleUsernameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
  };

  const makeAdmin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    console.log("Email: " + email);
    const addAdminRole = httpsCallable(functions, 'addAdminRole');
    addAdminRole({ email: email }).then((result) => {
      console.log(result);
    });
  };

  return (
    <div className="Main">
      <div className="SignInContainer">
        <form className="SignInForm" onSubmit={makeAdmin}>
          <label className="Username">
            Email:
            <input type="text" name="email" onChange={handleUsernameChange} />
          </label>
          <div className="MakeAdminButton">
            <input type="submit" value="Make Admin" />
          </div>
        </form>
      </div>
    </div>
  );
}

export default MakeAdminForm;
