import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CategoryDetailPage from "./CategoryDetailPage";
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

// The real body of GET /admin-api/v1/catalog/categories/:id: category
// fields (name mirrors cat_name), a plain styles array, beer_count.
// It carries NO beers and NO pagination.
const categoryDetail = {
  id: 3,
  cat_name: "Ale",
  last_mod: "2026-01-01T00:00:00.000Z",
  name: "Ale",
  styles: [
    { id: 5, style_name: "Fruit Beer", name: "Fruit Beer", cat_id: 3, last_mod: "2026-01-01T00:00:00.000Z" },
  ],
  beer_count: 1,
};

// The beers come from GET /catalog/beers?category_id=3, the standard
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

test("renders styles from the detail body and beers from the filtered list", async () => {
  mockApiGet.mockImplementation((path: string, params?: any) => {
    if (path === "/catalog/categories/3") return Promise.resolve(categoryDetail);
    if (path === "/catalog/beers") {
      expect(params).toEqual(expect.objectContaining({ category_id: "3" }));
      return Promise.resolve(beersEnvelope);
    }
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
  render(
    <MemoryRouter initialEntries={["/admin/catalog/categories/3"]}>
      <Routes>
        <Route path="/admin/catalog/categories/:id" element={<CategoryDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
  expect(await screen.findByRole("link", { name: "Fruit Beer" })).toHaveAttribute(
    "href",
    "/admin/catalog/styles/5"
  );
  const beerLink = await screen.findByRole("link", { name: "#9" });
  expect(beerLink).toHaveAttribute("href", "/admin/catalog/beers/101");
  expect(screen.getByText(/Page 1 of 1/)).toBeInTheDocument();
});
