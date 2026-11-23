import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import BreweryDetailPage from "./BreweryDetailPage";
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

// Serialized beer row, as produced by serializeBeerListRow in
// server/src/routes/catalog.ts.
const beerRow = {
  id: 101,
  name: "#9",
  brewery: { id: 12, name: "Magic Hat Brewing Company" },
  style: { id: 5, name: "Fruit Beer" },
  category: { id: 3, name: "Ale" },
  brewery_id: 12,
  style_id: 5,
  cat_id: 3,
  abv: 5.1,
  ibu: null,
  srm: null,
  discontinued: false,
  last_mod: "2026-01-01T00:00:00.000Z",
  image_url: null,
  image_kind: "initials",
  image_provenance: null,
};

// The real FLAT body of GET /admin-api/v1/catalog/breweries/:id:
// brewery fields, `beers` as a plain array, pagination at top level
// (duplicated as beers_pagination). NOT a { results, pagination }
// envelope under `beers`.
const breweryDetail = {
  id: 12,
  name: "Magic Hat Brewing Company",
  address1: "5 Bartlett Bay Rd",
  address2: null,
  city: "South Burlington",
  state: "VT",
  code: "05403",
  country: "United States",
  phone: null,
  website: "https://example.com",
  descript: "A brewery.",
  add_user: 1,
  last_mod: "2026-01-01T00:00:00.000Z",
  beer_count: 1,
  geocode: null as null | object,
  beers: [beerRow],
  beers_pagination: { page: 1, page_size: 25, total_results: 1, total_pages: 1 },
  pagination: { page: 1, page_size: 25, total_results: 1, total_pages: 1 },
};

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={["/admin/catalog/breweries/12"]}>
      <Routes>
        <Route path="/admin/catalog/breweries/:id" element={<BreweryDetailPage />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders beer rows and pagination from the flat detail shape", async () => {
  mockApiGet.mockResolvedValue(breweryDetail);
  renderDetail();
  expect(await screen.findByText("Magic Hat Brewing Company")).toBeInTheDocument();
  const beerLink = await screen.findByRole("link", { name: "#9" });
  expect(beerLink).toHaveAttribute("href", "/admin/catalog/beers/101");
  expect(screen.getByText(/Page 1 of 1 \(1 total\)/)).toBeInTheDocument();
});

test("renders the geocode block when a geocode row exists", async () => {
  mockApiGet.mockResolvedValue({
    ...breweryDetail,
    geocode: { id: 1, brewery_id: 12, latitude: 44.428, longitude: -73.213, accuracy: "ROOFTOP" },
  });
  renderDetail();
  expect(await screen.findByText("Geocode")).toBeInTheDocument();
  expect(screen.getByText("44.428")).toBeInTheDocument();
  expect(screen.getByText("-73.213")).toBeInTheDocument();
  expect(screen.getByText("ROOFTOP")).toBeInTheDocument();
});
