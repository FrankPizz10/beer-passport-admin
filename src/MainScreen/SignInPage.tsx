// React functional component
import React, { useEffect, useState } from "react";
import "./SignInForm.css";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { auth } from "../Firebase/firebase";
import { useNavigate } from "react-router-dom";

function SignInPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  let navigate = useNavigate();

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

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        console.log(`{user.email} is signed in`);
        navigate("/admin");
      }
    });
    return unsubscribe;
  }, []);

  return (
    <div className="Main">
      <div className="SignInContainer">
        <h1 className="Title">Sign In</h1>
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
          <div className="SignInButton">
            <input type="submit" value="Sign In" />
          </div>
        </form>
      </div>
    </div>
  );
}

export default SignInPage;
