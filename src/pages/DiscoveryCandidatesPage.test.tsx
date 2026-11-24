import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import DiscoveryCandidatesPage from "./DiscoveryCandidatesPage";
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

const candidate = (id: number, name: string) => ({
  id,
  batch_id: 3,
  candidate_key: `wikidata:Q${id}`,
  name,
  brewery_name: "Brewery One",
  style: "IPA",
  abv: 6.2,
  barcode: null,
  source: "wikidata",
  origin_bucket: "us_produced",
  image_status: "verified-by-review",
  image_status_normalized: "verified",
  image_verified: true,
  hold_reason: null,
  review_status: "pending",
  dedupe_outcome: "not_checked",
  matched_beer_id: null,
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

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/admin/discovery/batches/3/candidates"]}>
      <Routes>
        <Route
          path="/admin/discovery/batches/:batchId/candidates"
          element={<DiscoveryCandidatesPage />}
        />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders candidate rows with pagination totals", async () => {
  mockApiGet.mockResolvedValue(
    pageOf([candidate(1, "Alpha Ale"), candidate(2, "Beta Lager")])
  );
  renderPage();
  expect(await screen.findByText("Alpha Ale")).toBeInTheDocument();
  expect(await screen.findByText("Beta Lager")).toBeInTheDocument();
  expect(screen.getByText(/2 total/)).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Alpha Ale" })
  ).toHaveAttribute("href", "/admin/discovery/candidates/1");
  expect(mockApiGet).toHaveBeenCalledWith(
    "/discovery/batches/3/candidates",
    expect.objectContaining({ sort: "name" })
  );
});

test("renders the empty state when results is empty", async () => {
  mockApiGet.mockResolvedValue(pageOf([]));
  renderPage();
  expect(
    await screen.findByText(/No discovery candidates found/i)
  ).toBeInTheDocument();
});
