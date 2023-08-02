// React functional component
import React, { useEffect, useState } from "react";
import "./SignInForm.css";
import { signInWithEmailAndPassword, onAuthStateChanged } from "firebase/auth";
import { auth } from "../Firebase/firebase";
import { useNavigate } from "react-router-dom";

function SignInPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const navigate = useNavigate();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        user.getIdTokenResult().then((idTokenResult) => {
          if (idTokenResult.claims.admin) {
            console.log(`User is signed in with email ${user.email}`);
            // window.localStorage.setItem("auth", "true");
            console.log("idTokenResult", idTokenResult.token);
            navigate("/admin", { state: { token: idTokenResult.token } });
          }
        });
      }
    });
    return unsubscribe;
  }, []);

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
        <h1 className="Title">Admin Sign In</h1>
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
          {errorMessage && <p className="ErrorMessage">{errorMessage}</p>}
        </form>
      </div>
    </div>
  );
}

export default SignInPage;
