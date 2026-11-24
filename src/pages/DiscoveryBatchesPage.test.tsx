import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import DiscoveryBatchesPage from "./DiscoveryBatchesPage";
import { apiGet, apiPost, ApiError } from "../api/client";

jest.mock("../api/client", () => ({
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    details?: any;
    constructor(status: number, message: string, details?: any) {
      super(message);
      this.status = status;
      this.details = details;
    }
  },
}));

const mockApiGet = apiGet as jest.Mock;
const mockApiPost = apiPost as jest.Mock;

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

test("builds a manifest from the batch and navigates to its detail", async () => {
  mockApiGet.mockResolvedValue({ results: [batch] });
  mockApiPost.mockResolvedValue({ id: "mf-wikidata-2026-11-20261123-01" });
  render(
    <MemoryRouter initialEntries={["/admin/discovery/batches"]}>
      <Routes>
        <Route path="/admin/discovery/batches" element={<DiscoveryBatchesPage />} />
        <Route
          path="/admin/discovery/manifests/:id"
          element={<div>Manifest detail stub</div>}
        />
      </Routes>
    </MemoryRouter>
  );
  const button = await screen.findByRole("button", {
    name: "Build import manifest",
  });
  fireEvent.click(button);
  await waitFor(() =>
    expect(mockApiPost).toHaveBeenCalledWith(
      "/discovery/batches/3/manifests",
      {}
    )
  );
  expect(await screen.findByText("Manifest detail stub")).toBeInTheDocument();
});

test("surfaces manifest build eligibility blockers readably on a 422", async () => {
  mockApiGet.mockResolvedValue({ results: [batch] });
  mockApiPost.mockRejectedValue(
    new ApiError(422, "1 selected candidate(s) are not import-eligible; no manifest was built.", {
      error: { message: "blocked" },
      blockers: [
        { candidate_id: 12, candidate_key: "off:2", reasons: ["image_unverified"] },
      ],
    })
  );
  render(
    <MemoryRouter>
      <DiscoveryBatchesPage />
    </MemoryRouter>
  );
  const button = await screen.findByRole("button", {
    name: "Build import manifest",
  });
  fireEvent.click(button);
  expect(
    await screen.findByText(/off:2 \(candidate 12\): image_unverified/)
  ).toBeInTheDocument();
});

test("review progress renders as a progress bar with status chips at the API's real totals", async () => {
  mockApiGet.mockResolvedValue({ results: [batch] });
  render(
    <MemoryRouter>
      <DiscoveryBatchesPage />
    </MemoryRouter>
  );
  expect(await screen.findByText("Wikidata Harvest")).toBeInTheDocument();
  const bar = screen.getByRole("progressbar", {
    name: /Review progress for Wikidata Harvest/,
  });
  expect(bar).toHaveAttribute("aria-valuenow", "25");
  expect(bar).toHaveAttribute("aria-valuemin", "0");
  expect(bar).toHaveAttribute("aria-valuemax", "100");
  // Status chips carry text labels with the API's counts.
  expect(screen.getByText("pending: 90")).toBeInTheDocument();
  expect(screen.getByText("decided: 30")).toBeInTheDocument();
  // The batch status itself is a labeled chip, and the record
  // count is the full staged total (120), not a sample.
  expect(screen.getByText("staged")).toBeInTheDocument();
  expect(screen.getByText("120")).toBeInTheDocument();
});
