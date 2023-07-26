import React from "react";
import "./App.css";
import SignInPage from "./MainScreen/SignInPage";
import { Route, Routes } from "react-router-dom";
import AdminHomePage from "./MainScreen/AdminHomePage";

function App() {
  return (
    <Routes>
      <Route path="/" element={<SignInPage />} />
      <Route path="/admin" element={<AdminHomePage />} />
    </Routes>
  );
}

export default App;
