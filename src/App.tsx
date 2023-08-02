import React, { useEffect, useState } from "react";
import "./App.css";
import SignInPage from "./MainScreen/SignInPage";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import AdminHomePage from "./MainScreen/AdminHomePage";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SignInPage />} />
        <Route path="/admin" element={<AdminHomePage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
