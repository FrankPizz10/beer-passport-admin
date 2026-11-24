import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DiscoveryImageReviewPanel from "./DiscoveryImageReviewPanel";
import { apiGet, apiGetBlobUrl } from "../api/client";

// Review-workflow additions to the image panel: for a candidate that
// matched an existing catalog beer, the panel must name that beer,
// keep the preview bound to the stored bytes (never the origin URL),
// and state that an image decision is not an import.
jest.mock("../api/client", () => ({
  apiGet: jest.fn(),
  apiPost: jest.fn(async () => ({})),
  apiGetBlobUrl: jest.fn(async () => "blob:preview-url"),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const mockApiGet = apiGet as jest.Mock;
const mockApiGetBlobUrl = apiGetBlobUrl as jest.Mock;

const ORIGIN_URL = "https://images.example.com/bud-origin.png";

const candidate = {
  id: 42,
  batch_id: 3,
  candidate_key: "off:018200530009",
  name: "Bud Light (staged)",
  brewery_name: "Anheuser-Busch",
  style: "Lager",
  abv: 4.2,
  barcode: "018200530009",
  source: "open_food_facts",
  origin_bucket: "us_produced",
  image_status: "staged",
  image_status_normalized: "none",
  image_verified: false,
  hold_reason: null,
  review_status: "pending",
  dedupe_outcome: "catalog_match",
  matched_beer_id: 7,
  image_url: ORIGIN_URL,
  image_source: "open_food_facts",
  image_license: "CC0",
  image_decision: null,
  image_decision_fetch_id: null,
  image_decision_at: null,
} as any;

const successFetch = {
  id: 51,
  candidate_id: 42,
  image_ref: ORIGIN_URL,
  sha256: "a".repeat(64),
  content_type: "image/png",
  byte_size: 12345,
  width: 800,
  height: 600,
  outcome: "success",
  outcome_detail: null,
  fetched_by: { id: 1, user_name: "Admin One" },
  fetched_at: "2026-11-23T10:00:00.000Z",
  decision: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockApiGetBlobUrl.mockResolvedValue("blob:preview-url");
  mockApiGet.mockImplementation((path: string) => {
    if (path.includes("/image-fetches")) {
      return Promise.resolve({
        results: [successFetch],
        pagination: { page: 1, page_size: 100, total_results: 1, total_pages: 1 },
      });
    }
    if (path.includes("/image-decisions")) {
      return Promise.resolve({
        results: [],
        pagination: { page: 1, page_size: 100, total_results: 0, total_pages: 0 },
      });
    }
    if (path === "/catalog/beers/7") {
      return Promise.resolve({
        id: 7,
        name: "Bud Light",
        brewery: { id: 3, name: "Anheuser-Busch" },
      });
    }
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
});

test("existing-beer image review: explicit target beer, stored-bytes preview, decision is not import", async () => {
  render(
    <MemoryRouter>
      <DiscoveryImageReviewPanel candidate={candidate} />
    </MemoryRouter>
  );

  // The target beer is named explicitly before any decision.
  expect(await screen.findByText(/#7 - Bud Light/)).toBeInTheDocument();
  expect(
    screen.getByText(/records an image decision for catalog beer #7 only/)
  ).toBeInTheDocument();

  // The preview image renders the API's stored bytes (blob URL from
  // the preview endpoint), never the origin URL.
  const img = (await screen.findByAltText(
    "Fetched preview for Bud Light (staged)"
  )) as HTMLImageElement;
  expect(img.src).toContain("blob:preview-url");
  expect(img.src).not.toContain("bud-origin.png");
  expect(mockApiGetBlobUrl).toHaveBeenCalledWith(
    "/discovery/image-fetches/51/preview"
  );

  // The origin URL appears as provenance text only.
  expect(screen.getAllByText(ORIGIN_URL).length).toBeGreaterThan(0);

  // The decision-vs-import distinction is stated next to the actions.
  expect(
    screen.getByText(/records an image decision only/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Nothing is published or imported by this decision/)
  ).toBeInTheDocument();
});
