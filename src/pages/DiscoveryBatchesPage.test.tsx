import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DiscoveryBatchesPage from "./DiscoveryBatchesPage";
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

const batch = {
  id: 3,
  slug: "wikidata-2026-11",
  title: "Wikidata Harvest",
  source: "wikidata",
  source_summary: "SPARQL pull of canned beverages",
  record_count: 120,
  status: "staged",
  bundle_sha256: "abc123",
  ingested_at: "2026-11-23T00:00:00.000Z",
  counts: {
    by_origin_bucket: { us_produced: 80, uncertain: 40 },
    by_image_status: { verified: 30, none: 90 },
    by_hold_reason: { origin_uncertain: 40 },
    by_review_status: { pending: 90, decided: 30 },
  },
  review_progress: { total: 120, decided: 30, pending: 90, percent_reviewed: 25 },
};

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders a batch with counts and review progress", async () => {
  mockApiGet.mockResolvedValue({ results: [batch] });
  render(
    <MemoryRouter>
      <DiscoveryBatchesPage />
    </MemoryRouter>
  );
  expect(await screen.findByText("Wikidata Harvest")).toBeInTheDocument();
  expect(screen.getByText("wikidata")).toBeInTheDocument();
  expect(screen.getByText(/30\/120 reviewed \(25%\)/)).toBeInTheDocument();
  expect(screen.getByText(/us_produced: 80/)).toBeInTheDocument();
  expect(screen.getByText(/verified: 30/)).toBeInTheDocument();
  expect(screen.getByText(/origin_uncertain: 40/)).toBeInTheDocument();
  const links = screen.getAllByRole("link", { name: /wikidata harvest|view candidates/i });
  expect(links.length).toBeGreaterThan(0);
  links.forEach((link) =>
    expect(link).toHaveAttribute(
      "href",
      "/admin/discovery/batches/3/candidates"
    )
  );
});

test("renders the empty state when there are no batches", async () => {
  mockApiGet.mockResolvedValue({ results: [] });
  render(
    <MemoryRouter>
      <DiscoveryBatchesPage />
    </MemoryRouter>
  );
  expect(
    await screen.findByText(/No discovery batches found/i)
  ).toBeInTheDocument();
});

test("renders the error state when apiGet rejects", async () => {
  mockApiGet.mockRejectedValue(new Error("Server exploded"));
  render(
    <MemoryRouter>
      <DiscoveryBatchesPage />
    </MemoryRouter>
  );
  expect(await screen.findByText("Server exploded")).toBeInTheDocument();
});
