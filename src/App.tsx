import "./App.css";
import SignInPage from "./MainScreen/SignInPage";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import AdminHomePage from "./MainScreen/AdminHomePage";
import SheetsPage from "./MainScreen/SheetsPage";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SignInPage />} />
        <Route path="/admin" element={<AdminHomePage user=""/>} />
        <Route path="/sheets" element={<SheetsPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
