import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import StyleDetailPage from "./StyleDetailPage";
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

// The real body of GET /admin-api/v1/catalog/styles/:id: style fields
// (name mirrors style_name), a category ref, beer_count. It carries
// NO beers and NO pagination.
const styleDetail = {
  id: 5,
  cat_id: 3,
  style_name: "Fruit Beer",
  last_mod: "2026-01-01T00:00:00.000Z",
  name: "Fruit Beer",
  category: { id: 3, name: "Ale" },
  beer_count: 1,
};

// The beers come from GET /catalog/beers?style_id=5, the standard
// list envelope with serialized beer rows.
const beersEnvelope = {
  results: [
    {
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
    },
  ],
  pagination: { page: 1, page_size: 25, total_results: 1, total_pages: 1 },
};

test("renders the category link and beers from the filtered list", async () => {
  mockApiGet.mockImplementation((path: string, params?: any) => {
    if (path === "/catalog/styles/5") return Promise.resolve(styleDetail);
    if (path === "/catalog/beers") {
      expect(params).toEqual(expect.objectContaining({ style_id: "5" }));
      return Promise.resolve(beersEnvelope);
    }
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
  render(
    <MemoryRouter initialEntries={["/admin/catalog/styles/5"]}>
      <Routes>
        <Route path="/admin/catalog/styles/:id" element={<StyleDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
  expect(await screen.findByRole("link", { name: "Ale" })).toHaveAttribute(
    "href",
    "/admin/catalog/categories/3"
  );
  const beerLink = await screen.findByRole("link", { name: "#9" });
  expect(beerLink).toHaveAttribute("href", "/admin/catalog/beers/101");
  expect(screen.getByText(/Page 1 of 1/)).toBeInTheDocument();
});
