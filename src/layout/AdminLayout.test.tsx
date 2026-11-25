import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
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

test("signed-in admin sees the shell; the nav toggle expands and collapses the sidebar", async () => {
  const { apiGet } = jest.requireMock("../api/client");
  (apiGet as jest.Mock).mockResolvedValue({
    host: "localhost",
    port: 54329,
    database: "beerpassport_dev",
    firebase_configured: false,
  });
  mockOnAuth.mockImplementation((_auth: unknown, cb: (u: unknown) => void) => {
    cb({
      email: "admin@example.com",
      getIdTokenResult: () =>
        Promise.resolve({ claims: { admin: true } }),
    });
    return () => {};
  });
  render(
    <MemoryRouter initialEntries={["/admin/discovery/batches"]}>
      <Routes>
        <Route path="/" element={<div>Sign In Screen</div>} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route
            path="discovery/batches"
            element={<div>Batch Content</div>}
          />
        </Route>
      </Routes>
    </MemoryRouter>
  );
  expect(await screen.findByText("Batch Content")).toBeInTheDocument();
  // Breadcrumb reflects the route.
  expect(
    screen.getByRole("navigation", { name: "Breadcrumb" })
  ).toHaveTextContent(/Discovery/);
  const toggle = screen.getByRole("button", {
    name: "Toggle navigation menu",
  });
  const nav = screen.getByRole("navigation", { name: "Admin" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(nav.className).not.toContain("open");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(nav.className).toContain("open");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(nav.className).not.toContain("open");
  // Active navigation is visible: the Batches link carries the
  // router's active class.
  expect(screen.getByRole("link", { name: "Batches" }).className).toContain(
    "active"
  );
});

test("nav uses the clearer labels and the account menu holds email, target, and logout", async () => {
  const { apiGet } = jest.requireMock("../api/client");
  (apiGet as jest.Mock).mockResolvedValue({
    host: "localhost",
    port: 54329,
    database: "beerpassport_dev",
    firebase_configured: false,
  });
  mockOnAuth.mockImplementation((_auth: unknown, cb: (u: unknown) => void) => {
    cb({
      email: "admin@example.com",
      getIdTokenResult: () =>
        Promise.resolve({ claims: { admin: true } }),
    });
    return () => {};
  });
  render(
    <MemoryRouter initialEntries={["/admin/discovery/batches"]}>
      <Routes>
        <Route path="/" element={<div>Sign In Screen</div>} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route
            path="discovery/batches"
            element={<div>Batch Content</div>}
          />
        </Route>
      </Routes>
    </MemoryRouter>
  );
  expect(await screen.findByText("Batch Content")).toBeInTheDocument();
  // Renamed nav label + the new queue link.
  expect(
    screen.getByRole("link", { name: "Catalog Image Approvals" })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Review Queue" })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Image Queue" })
  ).not.toBeInTheDocument();
  // Logout is behind the account menu, not inline in the header.
  expect(screen.queryByText("Logout")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
  expect(
    await screen.findByRole("menuitem", { name: "Logout" })
  ).toBeInTheDocument();
  expect(screen.getByText(/admin@example.com/)).toBeInTheDocument();
});
