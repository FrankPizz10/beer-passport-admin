// React functional component
import React, { useState } from "react";
import "./SignInForm.css";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { auth } from "../Firebase/firebase";

function SignInForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const handleUsernameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setUsername(event.target.value);
  };

  const handlePasswordChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(event.target.value);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    console.log("Username: " + username);
    console.log("Password: " + password);
    try {
      const userCredentials = await signInWithEmailAndPassword(
        auth,
        username,
        password
      );
      const user = userCredentials.user;
      console.log("Logged in with:", user.email);
    } catch (error: any) {
      const errorCode = error.code;
      const errorMessage = error.message;
      console.log("Error Code: ", errorCode);
      console.log("Error Message: ", errorMessage);
    }
  };

  return (
    <div className="Main">
      <div className="SignInContainer">
        <h1>Sign In</h1>
        <form className="SignInForm" onSubmit={handleSubmit}>
          <label className="Username">
            Username:
            <input
              type="text"
              name="username"
              onChange={handleUsernameChange}
            />
          </label>
          <label className="Password">
            Password:
            <input
              type="password"
              name="password"
              onChange={handlePasswordChange}
            />
          </label>
          <input type="submit" value="Submit" />
        </form>
      </div>
    </div>
  );
}

export default SignInForm;
