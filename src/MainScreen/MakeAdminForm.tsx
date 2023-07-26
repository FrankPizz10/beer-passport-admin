// React functional component
import React, { useState } from "react";
import "./SignInForm.css";

function MakeAdminForm() {
  const [email, setEmail] = useState("");

  const handleUsernameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
  };

  const makeAdmin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    console.log("Email: " + email);
    try {
      const response = await fetch(
        "https://addadminrole-zmqrfdjwaq-uc.a.run.app",
        {
          method: "POST", // or 'POST', 'PUT', etc. depending on your function's implementation
          headers: {
            "Content-Type": "application/json", // Set the content type you are sending in the request
            // Add any additional headers you might need (e.g., authorization token)
          },
          // Add request body if needed (e.g., for POST or PUT requests)
          body: JSON.stringify({ email: email }),
        }
      );
      const data = await response.json();
      console.log(data);
    } catch (error: any) {
      console.log(error);
    }
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
