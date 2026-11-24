import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import DiscoveryCandidateDetailPage from "./DiscoveryCandidateDetailPage";
import { apiGet, apiPost } from "../api/client";

jest.mock("../api/client", () => ({
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  apiGetBlobUrl: jest.fn(async () => "blob:preview"),
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
      decided_by: null,
      decided_at: null,
      rival: { id: 10, name: "Alpha Ale Clone", brewery_name: "Brewery Two" },
    },
  ],
};

const emptyDecisions = {
  results: [],
  pagination: { page: 1, page_size: 100, total_results: 0, total_pages: 0 },
};

const mockGets = (detailValue: unknown, decisionsValue: unknown = emptyDecisions) => {
  mockApiGet.mockImplementation((path: string) => {
    // The Phase 4 image review panel reads its own lists; both are
    // empty in these page-level tests (the panel has its own suite).
    if (path.includes("/image-fetches") || path.includes("/image-decisions")) {
      return Promise.resolve(emptyDecisions);
    }
    return Promise.resolve(path.includes("/decisions") ? decisionsValue : detailValue);
  });
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
  mockApiPost.mockResolvedValue({});
});

test("renders provenance, origin evidence, and pairs", async () => {
  mockGets(detail);
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
  // Image status, verbatim and normalized (the verbatim status shows
  // twice: the Image section and the Phase 4 Image Review panel).
  expect(screen.getAllByText("verified-by-review")).toHaveLength(2);
  // Pairs, with a link into the side-by-side pair review
  expect(screen.getByText(/same_name_brewery/)).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: /Alpha Ale Clone/ })
  ).toHaveAttribute("href", "/admin/discovery/candidates/10");
  expect(
    screen.getByRole("link", { name: "Review pair" })
  ).toHaveAttribute("href", "/admin/discovery/pairs/1");
});

test("renders empty origin evidence and pairs messages", async () => {
  mockGets({
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
  expect(screen.getByText("No decisions recorded yet")).toBeInTheDocument();
});

test("select is disabled with an explanation while a duplicate pair is unresolved", async () => {
  mockGets(detail);
  renderDetail();
  const selectButton = await screen.findByRole("button", {
    name: "Select candidate",
  });
  expect(selectButton).toBeDisabled();
  expect(
    screen.getByText(/Selection is blocked until the unresolved duplicate pair/)
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "review pair 1" })
  ).toHaveAttribute("href", "/admin/discovery/pairs/1");
});

test("select is enabled with no pairs and posts the decision", async () => {
  mockGets({ ...detail, pairs: [] });
  renderDetail();
  const selectButton = await screen.findByRole("button", {
    name: "Select candidate",
  });
  expect(selectButton).toBeEnabled();
  fireEvent.click(selectButton);
  await waitFor(() =>
    expect(mockApiPost).toHaveBeenCalledWith("/discovery/candidates/9/decide", {
      decision: "select",
    })
  );
});

test("hold requires a reason, then posts decision, reason, and note", async () => {
  mockGets({ ...detail, pairs: [] });
  renderDetail();
  const holdButton = await screen.findByRole("button", {
    name: "Hold candidate",
  });
  fireEvent.click(holdButton);
  expect(
    await screen.findByText(/Choose a reason before recording a hold decision/)
  ).toBeInTheDocument();
  expect(mockApiPost).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(/Reason \(required for hold and reject\)/), {
    target: { value: "origin_uncertain" },
  });
  fireEvent.change(screen.getByLabelText(/Note \(optional/), {
    target: { value: "No production evidence yet." },
  });
  fireEvent.click(holdButton);
  await waitFor(() =>
    expect(mockApiPost).toHaveBeenCalledWith("/discovery/candidates/9/decide", {
      decision: "hold",
      reason: "origin_uncertain",
      note: "No production evidence yet.",
    })
  );
});

test("a held candidate explains that select is unavailable and offers unhold", async () => {
  mockGets({
    ...detail,
    pairs: [],
    review_status: "held",
    hold_reason: "origin_uncertain",
  });
  renderDetail();
  expect(
    await screen.findByText(/a held candidate cannot be selected/)
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Select candidate" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Unhold candidate" })).toBeEnabled();
});

test("a final candidate shows no decision controls", async () => {
  mockGets({ ...detail, pairs: [], review_status: "rejected" });
  renderDetail();
  expect(
    await screen.findByText(/That state is final and it cannot be decided again/)
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /candidate$/ })
  ).not.toBeInTheDocument();
});

test("the review flow is five numbered sections with separate decisions, help tips, and no stale deployment copy", async () => {
  mockGets(detail);
  renderDetail();
  expect(
    await screen.findByRole("heading", { name: "Alpha Ale" })
  ).toBeInTheDocument();
  // The five-step structure, in order, as section headings.
  for (const title of [
    "Staged beer and source evidence",
    "Review intent",
    "Image review",
    "Candidate decision",
    "What happens next",
  ]) {
    expect(
      screen.getByRole("heading", { name: title })
    ).toBeInTheDocument();
  }
  // Decision separation is stated on the page: intent is not
  // selection, and nothing here publishes or imports.
  expect(
    screen.getByText(/None of them implies another/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/publishes nothing on its own/)
  ).toBeInTheDocument();
  // Contextual help is present for the key terms, with accessible
  // names.
  for (const topic of [
    "review intent",
    "image decision",
    "candidate selection",
    "hold reasons",
    "manifest hash",
    "import",
  ]) {
    expect(
      screen.getByRole("button", { name: `Help: ${topic}` })
    ).toBeInTheDocument();
  }
  // Stale deployment-status copy is gone from the rendered page.
  const pageText = document.body.textContent ?? "";
  expect(pageText).not.toMatch(/not yet deployed/i);
  expect(pageText).not.toMatch(/pending backend/i);
  expect(pageText).not.toMatch(/not deployed or merged/i);
  expect(pageText).not.toMatch(/implemented locally/i);
});

test("decision history renders the decider name, decision, and reason", async () => {
  mockGets(detail, {
    results: [
      {
        id: 5,
        candidate_id: 9,
        pair_id: null,
        decision: "hold",
        from_status: "pending",
        to_status: "held",
        reason: "origin_uncertain",
        note: null,
        decided_by: { id: 1, user_name: "Admin One" },
        created_at: "2026-11-23T12:00:00.000Z",
      },
    ],
    pagination: { page: 1, page_size: 100, total_results: 1, total_pages: 1 },
  });
  renderDetail();
  expect(await screen.findByText(/Admin One/)).toBeInTheDocument();
  expect(screen.getByText(/Reason: origin_uncertain/)).toBeInTheDocument();
});
