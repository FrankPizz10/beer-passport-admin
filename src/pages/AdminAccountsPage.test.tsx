import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AdminAccountsPage from "./AdminAccountsPage";
import { apiGet, apiPost } from "../api/client";

jest.mock("../api/client", () => ({ apiGet: jest.fn(), apiPost: jest.fn() }));
const accounts = { owner: { uid: "owner", email: "owner@example.com", user_name: "Owner" }, writes_enabled: true,
  results: [{ uid: "reviewer", email: "reviewer@example.com", user_name: "Reviewer", granted_at: "2026-11-25T00:00:00Z" }] };
beforeEach(() => {
  jest.resetAllMocks();
  (apiGet as jest.Mock).mockImplementation((path: string) => Promise.resolve(path === "/admin/accounts" ? accounts : { results: [] }));
  (apiPost as jest.Mock).mockResolvedValue({});
  jest.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => jest.restoreAllMocks());

test("grants an existing account only after confirming the email", async () => {
  render(<AdminAccountsPage />);
  await screen.findByText(/owner@example.com/);
  fireEvent.change(screen.getByLabelText("Account email"), { target: { value: "new@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Grant admin access" }));
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/admin/accounts", { email: "new@example.com" }));
});

test("does not revoke when confirmation is canceled", async () => {
  (window.confirm as jest.Mock).mockReturnValue(false);
  render(<AdminAccountsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  expect(apiPost).not.toHaveBeenCalled();
});

test("reports when the owner write connection is disabled", async () => {
  (apiGet as jest.Mock).mockImplementation((path: string) => Promise.resolve(path === "/admin/accounts" ? { ...accounts, writes_enabled: false } : { results: [] }));
  render(<AdminAccountsPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent("not configured");
  expect(screen.getByRole("button", { name: "Grant admin access" })).toBeDisabled();
});
