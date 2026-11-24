import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import DiscoveryCandidateDetailPage from "./DiscoveryCandidateDetailPage";
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

const detail = {
  id: 9,
  batch_id: 3,
  candidate_key: "wikidata:Q123",
  name: "Alpha Ale",
  brewery_name: "Brewery One",
  style: "IPA",
  abv: 6.2,
  ibu: 55,
  description: "A hoppy ale.",
  barcode: "012345678905",
  source: "wikidata",
  source_record_id: "Q123",
  source_url: "https://www.wikidata.org/wiki/Q123",
  retrieved_at: "2026-11-23T00:00:00.000Z",
  tier: "1",
  origin_bucket: "us_produced",
  origin_evidence: [
    { signal: "country", value: "United States" },
    { signal: "brewery_country", value: "US" },
  ],
  image_url: "https://images.example.com/alpha.png",
  image_source: "wikimedia_commons",
  image_tier: "A",
  image_status: "verified-by-review",
  image_status_normalized: "verified",
  image_verified: true,
  image_flag_reason: null,
  image_license: "CC0",
  image_page_url: "https://commons.wikimedia.org/wiki/File:Alpha.png",
  image_width: 800,
  image_height: 600,
  hold_reason: null,
  hold_note: null,
  review_status: "pending",
  dedupe_outcome: "possible_duplicate",
  matched_beer_id: null,
  duplicate_of_candidate_id: null,
  created_at: "2026-11-23T00:00:00.000Z",
  updated_at: "2026-11-23T00:00:00.000Z",
  batch: { id: 3, slug: "wikidata-2026-11", title: "Wikidata Harvest" },
  pairs: [
    {
      id: 1,
      candidate_id: 9,
      candidate_id_b: 10,
      external_ref: null,
      comparison: "same_name_brewery",
      method: "fuzzy",
      score: 0.92,
      status: "pending",
      rival: { id: 10, name: "Alpha Ale Clone", brewery_name: "Brewery Two" },
    },
  ],
};

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={["/admin/discovery/candidates/9"]}>
      <Routes>
        <Route
          path="/admin/discovery/candidates/:id"
          element={<DiscoveryCandidateDetailPage />}
        />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders provenance, origin evidence, and pairs read-only", async () => {
  mockApiGet.mockResolvedValue(detail);
  renderDetail();
  expect(
    await screen.findByRole("heading", { name: "Alpha Ale" })
  ).toBeInTheDocument();
  // Provenance
  expect(screen.getByText("Q123")).toBeInTheDocument();
  expect(screen.getByText("wikidata:Q123")).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "https://www.wikidata.org/wiki/Q123" })
  ).toHaveAttribute("href", "https://www.wikidata.org/wiki/Q123");
  expect(
    screen.getByRole("link", { name: "Wikidata Harvest" })
  ).toHaveAttribute("href", "/admin/discovery/batches/3/candidates");
  // Origin evidence
  expect(screen.getByText(/country: United States/)).toBeInTheDocument();
  expect(screen.getByText(/brewery_country: US/)).toBeInTheDocument();
  // Image status, verbatim and normalized
  expect(screen.getByText("verified-by-review")).toBeInTheDocument();
  // Pairs
  expect(screen.getByText(/same_name_brewery/)).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: /Alpha Ale Clone/ })
  ).toHaveAttribute("href", "/admin/discovery/candidates/10");
  // Read-only phase: no decision controls anywhere.
  expect(
    screen.queryByRole("button", { name: /approve|reject|accept|merge|hold|decide/i })
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/approve candidate/i)).not.toBeInTheDocument();
});

test("renders empty origin evidence and pairs messages", async () => {
  mockApiGet.mockResolvedValue({
    ...detail,
    origin_evidence: null,
    pairs: [],
  });
  renderDetail();
  expect(
    await screen.findByText("No origin evidence recorded")
  ).toBeInTheDocument();
  expect(
    screen.getByText("No duplicate pairs recorded")
  ).toBeInTheDocument();
});
