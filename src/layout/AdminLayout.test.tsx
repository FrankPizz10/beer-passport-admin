import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AdminLayout from "./AdminLayout";
import { onAuthStateChanged } from "firebase/auth";

jest.mock("firebase/auth", () => ({
  onAuthStateChanged: jest.fn(),
}));

jest.mock("../Firebase/firebase", () => ({
  auth: { currentUser: null, signOut: jest.fn() },
  db: {},
  functions: {},
}));

jest.mock("../api/client", () => ({
  apiGet: jest.fn(() =>
    Promise.resolve({
      host: "localhost",
      port: 54329,
      database: "beerpassport_dev",
      firebase_configured: false,
    })
  ),
}));

const mockOnAuth = onAuthStateChanged as jest.Mock;

test("no user navigates to sign in", async () => {
  mockOnAuth.mockImplementation((_auth: unknown, cb: (u: unknown) => void) => {
    cb(null);
    return () => {};
  });
  render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/" element={<div>Sign In Screen</div>} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<div>Admin Content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
  expect(await screen.findByText("Sign In Screen")).toBeInTheDocument();
});
