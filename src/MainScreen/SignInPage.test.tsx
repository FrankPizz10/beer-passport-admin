import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import SignInPage from "./SignInPage";
import { onAuthStateChanged, signInWithEmailAndPassword } from "firebase/auth";

jest.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: jest.fn(),
  onAuthStateChanged: jest.fn(),
}));

jest.mock("../Firebase/firebase", () => ({
  auth: {},
  db: {},
  functions: {},
}));

const mockOnAuth = onAuthStateChanged as jest.Mock;
const mockSignIn = signInWithEmailAndPassword as jest.Mock;

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<SignInPage />} />
        <Route path="/admin" element={<div>Admin Home</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function userWithClaims(claims: Record<string, unknown>) {
  return {
    email: "admin@example.com",
    getIdTokenResult: () => Promise.resolve({ claims }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test("signed in admin navigates to /admin", async () => {
  mockOnAuth.mockImplementation((_auth: unknown, cb: (u: unknown) => void) => {
    cb(userWithClaims({ admin: true }));
    return () => {};
  });
  renderPage();
  expect(await screen.findByText("Admin Home")).toBeInTheDocument();
});

test("signed in user without admin claim shows not an admin message", async () => {
  mockOnAuth.mockImplementation((_auth: unknown, cb: (u: unknown) => void) => {
    cb(userWithClaims({}));
    return () => {};
  });
  renderPage();
  expect(await screen.findByText("User is not an admin!")).toBeInTheDocument();
});

test("failed sign in shows the error text visibly", async () => {
  mockOnAuth.mockImplementation((_auth: unknown, cb: (u: unknown) => void) => {
    cb(null);
    return () => {};
  });
  mockSignIn.mockRejectedValue(new Error("Invalid credentials for test"));
  const { container } = renderPage();
  const username = container.querySelector('input[name="username"]') as HTMLInputElement;
  const password = container.querySelector('input[name="password"]') as HTMLInputElement;
  fireEvent.change(username, { target: { value: "admin@example.com" } });
  fireEvent.change(password, { target: { value: "wrong" } });
  const form = container.querySelector("form") as HTMLFormElement;
  fireEvent.submit(form);
  await waitFor(() =>
    expect(screen.getByText("Invalid credentials for test")).toBeInTheDocument()
  );
});
