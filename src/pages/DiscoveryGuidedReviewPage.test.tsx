import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import DiscoveryGuidedReviewPage from "./DiscoveryGuidedReviewPage";
import { ApiError } from "../api/client";
import {
  DiscoveryReviewClient,
  ReviewIntentRecord,
} from "../api/discoveryReview";
import {
  DiscoveryCandidate,
  DiscoveryCandidateDetail,
  DiscoveryImageFetch,
} from "../api/types";

jest.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    details?: any;
    constructor(status: number, message: string, details?: any) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.details = details;
    }
  },
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  apiGetBlobUrl: jest.fn(),
}));

// Guided review tests at the DiscoveryReviewClient interface level:
// suggestions (WS1 contract A), the image gate and 429 guidance
// (WS3 contract B), the Approve orchestration through the UI, and
// keyboard navigation across a queue page boundary.

const detail = (
  overrides: Partial<DiscoveryCandidateDetail> = {}
): DiscoveryCandidateDetail =>
  ({
    id: 61,
    batch_id: 7,
    candidate_key: "bud-light",
    name: "Bud Light",
    brewery_name: "Budweiser",
    style: "Lager",
    abv: 4.2,
    ibu: null,
    barcode: "018200530027",
    description: null,
    source: "reassessment",
    source_record_id: "rec-61",
    source_url: "https://example.test/bud-light",
    retrieved_at: null,
    tier: null,
    origin_bucket: "us_produced",
    origin_evidence: null,
    image_url: "https://images.example.test/bud-light.jpg",
    image_source: "off",
    image_status: "verified",
    image_status_normalized: "verified",
    image_verified: true,
    image_tier: null,
    image_flag_reason: null,
    image_license: null,
    image_page_url: null,
    image_width: null,
    image_height: null,
    hold_reason: null,
    hold_note: null,
    review_status: "pending",
    dedupe_outcome: "no_match",
    matched_beer_id: null,
    duplicate_of_candidate_id: null,
    image_decision: null,
    image_decision_fetch_id: null,
    image_decision_at: null,
    created_at: "2026-11-20T00:00:00Z",
    updated_at: "2026-11-20T00:00:00Z",
    batch: { id: 7, slug: "candidates-us-full", title: "Full domestic set" },
    pairs: [],
    ...overrides,
  }) as DiscoveryCandidateDetail;

const successFetch: DiscoveryImageFetch = {
  id: 500,
  candidate_id: 61,
  image_ref: "sha",
  sha256: "a".repeat(64),
  content_type: "image/jpeg",
  byte_size: 12345,
  width: 400,
  height: 400,
  outcome: "success",
  outcome_detail: null,
  fetched_by: { id: 1, user_name: "reviewer" },
  fetched_at: "2026-11-20T01:00:00Z",
  decision: null,
};

const emptyList = {
  results: [],
  pagination: { page: 1, page_size: 100, total_results: 0, total_pages: 1 },
};

interface FakeGuided {
  client: DiscoveryReviewClient;
  calls: { name: string; args: any[] }[];
}

const makeFake = (options: {
  candidates?: Record<number, DiscoveryCandidateDetail>;
  intent?: ReviewIntentRecord | null;
  fetches?: DiscoveryImageFetch[];
  suggestionsError?: Error | null;
  fetchError?: Error | null;
  nextPageRows?: DiscoveryCandidate[];
} = {}): FakeGuided => {
  const candidates = options.candidates ?? { 61: detail() };
  const calls: FakeGuided["calls"] = [];
  const record =
    (name: string, impl: (...args: any[]) => any) =>
    async (...args: any[]) => {
      calls.push({ name, args });
      return impl(...args);
    };
  const client = {
    getCandidate: jest.fn(
      record("getCandidate", async (id: number) => {
        const found = candidates[id];
        if (!found) throw new ApiError(404, "Candidate not found.");
        return found;
      })
    ),
    getReviewIntent: jest.fn(
      record("getReviewIntent", async () => options.intent ?? null)
    ),
    saveReviewIntent: jest.fn(
      record("saveReviewIntent", async (_id: number, _e: any, intent: any) => ({
        id: 101,
        candidate_id: _id,
        intent,
        created_at: "2026-11-20T02:00:00Z",
      }))
    ),
    listImageFetches: jest.fn(
      record("listImageFetches", async () => ({
        results: options.fetches ?? [],
        pagination: {
          page: 1,
          page_size: 100,
          total_results: (options.fetches ?? []).length,
          total_pages: 1,
        },
      }))
    ),
    listImageDecisions: jest.fn(
      record("listImageDecisions", async () => emptyList)
    ),
    getCandidateDecisions: jest.fn(
      record("getCandidateDecisions", async () => emptyList)
    ),
    requestImageFetch: jest.fn(
      record("requestImageFetch", async () => {
        if (options.fetchError) throw options.fetchError;
        return successFetch;
      })
    ),
    getImagePreviewUrl: jest.fn(
      record("getImagePreviewUrl", async () => "blob:preview")
    ),
    decideImage: jest.fn(
      record("decideImage", async () => ({
        id: 900,
        candidate_id: 61,
        fetch_id: 500,
        decision: "approved",
      }))
    ),
    decideCandidate: jest.fn(
      record("decideCandidate", async (id: number, input: any) => {
        const base = candidates[id] ?? detail({ id });
        return {
          ...base,
          review_status:
            input.decision === "select"
              ? "selected"
              : input.decision === "hold"
                ? "held"
                : "rejected",
        };
      })
    ),
    getCatalogBeer: jest.fn(
      record("getCatalogBeer", async (id: number) => ({
        id,
        name: "Bud Light",
        brewery_name: "Anheuser-Busch",
        style: "Lager",
        abv: 4.2,
        ibu: null,
        barcode: "018200530027",
        description: null,
        image_url: null,
        updated_at: "2026-01-01T00:00:00Z",
      }))
    ),
    searchCatalogBeers: jest.fn(
      record("searchCatalogBeers", async () => ({
        results: [
          {
            id: 3784,
            name: "Bud Light",
            brewery_name: "Anheuser-Busch",
            style: "Lager",
            abv: 4.2,
            ibu: null,
            barcode: "018200530027",
            description: null,
            image_url: null,
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
        pagination: { page: 1, page_size: 20, total_results: 1, total_pages: 1 },
      }))
    ),
    getMatchSuggestions: jest.fn(
      record("getMatchSuggestions", async (id: number) => {
        if (options.suggestionsError) throw options.suggestionsError;
        return {
          candidate_id: id,
          suggestions: [
            {
              beer_id: 3784,
              name: "Bud Light",
              brewery_name: "Anheuser-Busch",
              abv: 4.2,
              barcode: "018200530027",
              score: 0.98,
              evidence: ["barcode_exact", "name_normalized"],
            },
          ],
          exhaustive: false,
          scanned: 1200,
        };
      })
    ),
    listBatches: jest.fn(record("listBatches", async () => ({ results: [] }))),
    listBatchCandidates: jest.fn(
      record("listBatchCandidates", async () => ({
        results: options.nextPageRows ?? [],
        pagination: {
          page: 2,
          page_size: 50,
          total_results: 6817,
          total_pages: 2,
        },
      }))
    ),
    getManifest: jest.fn(async () => {
      throw new Error("not used");
    }),
    approveManifest: jest.fn(async () => {
      throw new Error("not used");
    }),
  } as unknown as DiscoveryReviewClient;
  return { client, calls };
};

const renderGuided = (client: DiscoveryReviewClient, id = 61) =>
  render(
    <MemoryRouter
      initialEntries={[`/admin/discovery/review-queue/${id}?batch=7`]}
    >
      <Routes>
        <Route
          path="/admin/discovery/review-queue/:candidateId"
          element={<DiscoveryGuidedReviewPage client={client} />}
        />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  sessionStorage.clear();
});

test("suggestions render with evidence chips and the not-exhaustive note; picking a target never confirms it", async () => {
  const fake = makeFake({ fetches: [successFetch] });
  renderGuided(fake.client);
  expect(
    await screen.findByText("Barcode matches exactly")
  ).toBeInTheDocument();
  expect(screen.getByText("Name matches after normalization")).toBeInTheDocument();
  expect(
    screen.getByText(/Suggestions may not cover the whole catalog/)
  ).toBeInTheDocument();
  expect(screen.getByText(/Match 98%/)).toBeInTheDocument();

  fireEvent.click(
    screen.getByRole("button", { name: "Use as image-only target" })
  );
  // The mode is chosen and the target named, but Approve stays
  // disabled until the explicit confirmation step.
  expect(
    await screen.findByRole("button", { name: "Confirm target beer #3784" })
  ).toBeInTheDocument();
  const approveButtons = screen.getAllByRole("button", {
    name: "Approve for import",
  });
  expect(approveButtons[0]).toBeDisabled();
  expect(
    screen.getByText(/Confirm the exact target beer before approving/)
  ).toBeInTheDocument();

  fireEvent.click(
    screen.getByRole("button", { name: "Confirm target beer #3784" })
  );
  await waitFor(() => expect(approveButtons[0]).not.toBeDisabled());
});

test("a 404 from match suggestions hides the panel and keeps manual search", async () => {
  const fake = makeFake({
    suggestionsError: new ApiError(404, "Not found"),
  });
  renderGuided(fake.client);
  expect(
    await screen.findByText(/Match suggestions are not available/)
  ).toBeInTheDocument();
  // Manual catalog search is still reachable through the choice.
  userEvent.click(screen.getByRole("radio", { name: /Add image to existing beer/ }));
  expect(
    await screen.findByLabelText(/Search catalog beers by name/)
  ).toBeInTheDocument();
});

test("approve orchestration through the UI: intent saved, image skipped with a note, candidate selected", async () => {
  const fake = makeFake({ fetches: [] });
  renderGuided(fake.client);
  await screen.findByText("Staged beer");
  userEvent.click(screen.getByRole("radio", { name: /Add new/ }));
  const approve = screen.getAllByRole("button", {
    name: "Approve for import",
  })[0];
  await waitFor(() => expect(approve).not.toBeDisabled());
  fireEvent.click(approve);
  expect(await screen.findByText(/Ready for import/)).toBeInTheDocument();
  expect(
    screen.getByText(/Nothing has been published or imported/)
  ).toBeInTheDocument();
  const names = fake.calls.map((c) => c.name);
  expect(names).toContain("saveReviewIntent");
  expect(names).toContain("decideCandidate");
  expect(names).not.toContain("decideImage");
  // The skipped image step explains itself in the checklist.
  expect(
    screen.getByText(/No stored image preview exists/)
  ).toBeInTheDocument();
});

test("a saved intent preselects the mode and target as data", async () => {
  const fake = makeFake({
    fetches: [successFetch],
    intent: {
      id: 42,
      candidate_id: 61,
      intent: { mode: "image_only", target_beer_id: 3784 },
      created_at: "2026-11-20T00:30:00Z",
    },
  });
  renderGuided(fake.client);
  expect(
    await screen.findByText(/Image only for catalog beer #3784/)
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole("radio", { name: /Add image to existing beer/ })
    ).toBeChecked()
  );
  // Preselected as data, including the confirmation recorded when
  // the intent was saved: no fresh confirmation is demanded, and
  // Approve is enabled (it will skip re-saving the identical
  // intent).
  expect(screen.getByText(/Target confirmed/)).toBeInTheDocument();
  const approve = screen.getAllByRole("button", {
    name: "Approve for import",
  })[0];
  expect(approve).not.toBeDisabled();
});

test("a 429 image fetch with retry_after_seconds shows timed guidance", async () => {
  const fake = makeFake({
    fetches: [],
    fetchError: new ApiError(429, "Image fetch limit reached", {
      error: {
        code: "image_fetch_rate_limited",
        message: "Image fetch limit reached",
        retry_after_seconds: 900,
      },
    }),
  });
  renderGuided(fake.client);
  await screen.findByText("Staged beer");
  fireEvent.click(screen.getByRole("button", { name: "Fetch image for review" }));
  expect(
    await screen.findByText(/try again in about 15 minutes/)
  ).toBeInTheDocument();
});

test("keyboard: ] moves to the next candidate but never fires while typing", async () => {
  sessionStorage.setItem(
    "bp-review-queue-ids",
    JSON.stringify([61, 62])
  );
  sessionStorage.setItem(
    "bp-review-queue-state",
    JSON.stringify({
      batchId: 7,
      filter: "actionable",
      sub: "",
      page: 1,
      pageSize: 50,
      totalPages: 1,
    })
  );
  const fake = makeFake({
    candidates: {
      61: detail(),
      62: detail({ id: 62, name: "Coors Light", candidate_key: "coors" }),
    },
  });
  renderGuided(fake.client);
  await screen.findByText("Staged beer");

  // While typing in the catalog search box, ] must not navigate.
  userEvent.click(screen.getByRole("radio", { name: /Add image to existing beer/ }));
  const search = await screen.findByLabelText(/Search catalog beers by name/);
  search.focus();
  fireEvent.keyDown(document, { key: "]" });
  expect(screen.queryByText(/Coors Light/)).not.toBeInTheDocument();

  // Outside an input, ] advances to the next queued candidate.
  (document.activeElement as HTMLElement)?.blur();
  fireEvent.keyDown(document, { key: "]" });
  expect(
    await screen.findByRole("heading", { name: /Coors Light/ })
  ).toBeInTheDocument();
});

test("next at a page boundary fetches the neighboring queue page", async () => {
  sessionStorage.setItem("bp-review-queue-ids", JSON.stringify([61]));
  sessionStorage.setItem(
    "bp-review-queue-state",
    JSON.stringify({
      batchId: 7,
      filter: "actionable",
      sub: "",
      page: 1,
      pageSize: 50,
      totalPages: 2,
    })
  );
  const fake = makeFake({
    candidates: {
      61: detail(),
      62: detail({ id: 62, name: "Coors Light", candidate_key: "coors" }),
    },
    nextPageRows: [
      {
        id: 62,
        batch_id: 7,
        candidate_key: "coors",
        name: "Coors Light",
        brewery_name: "Coors",
        style: "Lager",
        abv: 4.2,
        barcode: null,
        source: "reassessment",
        origin_bucket: "us_produced",
        image_status: "none",
        image_status_normalized: "none",
        image_verified: false,
        hold_reason: null,
        review_status: "pending",
        dedupe_outcome: "no_match",
        matched_beer_id: null,
      },
    ],
  });
  renderGuided(fake.client);
  await screen.findByText("Staged beer");
  fireEvent.keyDown(document, { key: "]" });
  expect(
    await screen.findByRole("heading", { name: /Coors Light/ })
  ).toBeInTheDocument();
  const listCall = fake.calls.find((c) => c.name === "listBatchCandidates");
  expect(listCall?.args[1]).toMatchObject({ page: 2 });
});
