import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import BeersPage from "./BeersPage";
import { apiGet } from "../api/client";

jest.mock("../api/client", () => ({
  apiGet: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const mockApiGet = apiGet as jest.Mock;

const beer = (id: number, name: string) => ({
  id,
  name,
  abv: 5.1,
  ibu: 40,
  srm: 6,
  upc: "012345678905",
  discontinued: false,
  last_mod: "2026-01-01T00:00:00.000Z",
  brewery: { id: 1, name: "Brewery One" },
  style: { id: 2, name: "IPA" },
  category: { id: 3, name: "Ale" },
  image_url: null,
  image_kind: "initials",
  image_provenance: null,
});

const pageOf = (results: unknown[]) => ({
  results,
  pagination: {
    page: 1,
    page_size: 25,
    total_results: results.length,
    total_pages: results.length === 0 ? 0 : 1,
  },
});

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders beer rows with pagination totals", async () => {
  mockApiGet.mockResolvedValue(pageOf([beer(1, "Alpha Ale"), beer(2, "Beta Lager")]));
  render(
    <MemoryRouter>
      <BeersPage />
    </MemoryRouter>
  );
  expect(await screen.findByText("Alpha Ale")).toBeInTheDocument();
  expect(await screen.findByText("Beta Lager")).toBeInTheDocument();
  expect(screen.getByText(/2 total/)).toBeInTheDocument();
});

test("renders the empty state when results is empty", async () => {
  mockApiGet.mockResolvedValue(pageOf([]));
  render(
    <MemoryRouter>
      <BeersPage />
    </MemoryRouter>
  );
  expect(await screen.findByText(/beers table is empty in this database/i)).toBeInTheDocument();
});

test("renders the error state when apiGet rejects", async () => {
  mockApiGet.mockRejectedValue(new Error("Server exploded"));
  render(
    <MemoryRouter>
      <BeersPage />
    </MemoryRouter>
  );
  expect(await screen.findByText("Server exploded")).toBeInTheDocument();
});
