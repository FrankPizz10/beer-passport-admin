import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CollectionDetailPage from "./CollectionDetailPage";
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

// The real FLAT body of GET /admin-api/v1/catalog/collections/:id:
// collection fields, `beers` and `members` as plain arrays of member
// rows ({ id, beer, collection, created_at }), pagination at top
// level. NOT a { results, pagination } envelope.
const collectionDetail = {
  id: 4,
  name: "Pool Party",
  difficulty: 2,
  description: "Summer beers.",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  badge_holder_count: 3,
  beers: [
    {
      id: 55,
      beer: { id: 101, name: "#9" },
      collection: { id: 4, name: "Pool Party" },
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  members: [
    { id: 55, beer: { id: 101, name: "#9" }, created_at: "2026-01-01T00:00:00.000Z" },
  ],
  pagination: { page: 1, page_size: 25, total_results: 1, total_pages: 1 },
};

test("renders member rows and pagination from the flat detail shape", async () => {
  mockApiGet.mockResolvedValue(collectionDetail);
  render(
    <MemoryRouter initialEntries={["/admin/catalog/collections/4"]}>
      <Routes>
        <Route path="/admin/catalog/collections/:id" element={<CollectionDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
  expect(await screen.findByText("Pool Party")).toBeInTheDocument();
  const beerLink = await screen.findByRole("link", { name: "#9" });
  expect(beerLink).toHaveAttribute("href", "/admin/catalog/beers/101");
  expect(screen.getByText(/Page 1 of 1 \(1 total\)/)).toBeInTheDocument();
});
