import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CatalogOverviewPage from "./CatalogOverviewPage";
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

// The real body of GET /admin-api/v1/admin/overview (routes/admin.ts):
// the counts map under `counts`, with the same keys ALSO spread at the
// top level: { counts, ...counts }. Rendering the whole body used to
// hand React the nested counts object as a child and blank the app.
const counts = {
  beers: 5894,
  breweries: 1339,
  categories: 14,
  styles: 147,
  collections: 6,
  collection_beers: 30,
  beverage_images: 0,
  breweries_geocode: 12,
  users: 294,
  user_beers: 882,
  user_badges: 588,
  friends: 147,
  notifications: 294,
  api_keys: 2,
};
const overviewBody = { counts, ...counts };

test("renders one count card per table from the counts map", async () => {
  mockApiGet.mockResolvedValue(overviewBody);
  render(
    <MemoryRouter>
      <CatalogOverviewPage />
    </MemoryRouter>
  );
  expect(await screen.findByText("5894")).toBeInTheDocument();
  expect(screen.getByText("beers")).toBeInTheDocument();
  expect(screen.getByText("breweries")).toBeInTheDocument();
  expect(screen.getByText("1339")).toBeInTheDocument();
  expect(screen.getByText("api_keys")).toBeInTheDocument();
  expect(screen.getByText("Catalog Overview")).toBeInTheDocument();
});
