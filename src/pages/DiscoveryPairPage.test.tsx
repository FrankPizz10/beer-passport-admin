import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import DiscoveryPairPage from "./DiscoveryPairPage";
import { apiGet, apiPost } from "../api/client";

jest.mock("../api/client", () => ({
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const mockApiGet = apiGet as jest.Mock;
const mockApiPost = apiPost as jest.Mock;

const side = (overrides: Record<string, unknown> = {}) => ({
  id: 9,
  batch_id: 3,
  candidate_key: "wikidata:Q123",
  name: "Alpha Ale",
  brewery_name: "Brewery One",
  style: "IPA",
  abv: 6.2,
  barcode: "012345678905",
  source: "wikidata",
  source_record_id: "Q123",
  source_url: "https://www.wikidata.org/wiki/Q123",
  origin_bucket: "us_produced",
  image_status: "verified-by-review",
  image_status_normalized: "verified",
  image_verified: true,
  hold_reason: null,
  review_status: "pending",
  dedupe_outcome: "possible_duplicate",
  matched_beer_id: null,
  ...overrides,
});

const pairDetail = {
  id: 1,
  batch_id: 3,
  candidate_id: 9,
  candidate_id_b: 10,
  external_ref: null,
  comparison: "same_name_brewery",
  method: "fuzzy",
  score: 0.92,
  status: "pending",
  decided_by: null,
  decided_at: null,
  created_at: "2026-11-23T00:00:00.000Z",
  candidate: side(),
  rival: side({
    id: 10,
    candidate_key: "wikidata:Q124",
    name: "Alpha Ale Clone",
    brewery_name: "Brewery Two",
    source_record_id: "Q124",
    barcode: "012345678906",
  }),
};

const renderPair = () =>
  render(
    <MemoryRouter initialEntries={["/admin/discovery/pairs/1"]}>
      <Routes>
        <Route
          path="/admin/discovery/pairs/:pairId"
          element={<DiscoveryPairPage />}
        />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockApiPost.mockResolvedValue({});
});

test("renders both sides side by side with the score and decision controls", async () => {
  mockApiGet.mockResolvedValue(pairDetail);
  renderPair();
  expect(
    await screen.findByRole("heading", { name: "Duplicate Pair Review" })
  ).toBeInTheDocument();
  expect(screen.getByText("0.92")).toBeInTheDocument();
  expect(screen.getByText("same_name_brewery")).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Alpha Ale" })
  ).toHaveAttribute("href", "/admin/discovery/candidates/9");
  expect(
    screen.getByRole("link", { name: "Alpha Ale Clone" })
  ).toHaveAttribute("href", "/admin/discovery/candidates/10");
  expect(screen.getByText("Brewery One")).toBeInTheDocument();
  expect(screen.getByText("Brewery Two")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /Same beer: mark candidate as duplicate/ })
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Distinct beers" })
  ).toBeEnabled();
});

test("posts a distinct decision with the note", async () => {
  mockApiGet.mockResolvedValue(pairDetail);
  renderPair();
  fireEvent.change(await screen.findByLabelText(/Note \(optional\)/), {
    target: { value: "Different breweries and barcodes." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Distinct beers" }));
  await waitFor(() =>
    expect(mockApiPost).toHaveBeenCalledWith("/discovery/pairs/1/decide", {
      decision: "distinct",
      note: "Different breweries and barcodes.",
    })
  );
});

test("posts a same decision without a note", async () => {
  mockApiGet.mockResolvedValue(pairDetail);
  renderPair();
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Same beer: mark candidate as duplicate/,
    })
  );
  await waitFor(() =>
    expect(mockApiPost).toHaveBeenCalledWith("/discovery/pairs/1/decide", {
      decision: "same",
    })
  );
});

test("an external rival renders its reference and no rival card fields", async () => {
  mockApiGet.mockResolvedValue({
    ...pairDetail,
    candidate_id_b: null,
    external_ref: "batch-2:craftcans:512",
    rival: null,
  });
  renderPair();
  expect(
    await screen.findByText(/Rival \(external\): batch-2:craftcans:512/)
  ).toBeInTheDocument();
  expect(
    screen.getByText("Not staged in the hub (it lives in another batch).")
  ).toBeInTheDocument();
});

test("a decided pair shows the outcome and no controls", async () => {
  mockApiGet.mockResolvedValue({
    ...pairDetail,
    status: "distinct",
    decided_by: { id: 1, user_name: "Admin One" },
    decided_at: "2026-11-23T12:00:00.000Z",
  });
  renderPair();
  expect(
    await screen.findByText(/This pair was decided as distinct by Admin One/)
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Distinct beers/ })
  ).not.toBeInTheDocument();
});
