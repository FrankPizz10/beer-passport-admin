import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DiscoveryReviewQueuePage from "./DiscoveryReviewQueuePage";

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
import { DiscoveryReviewClient } from "../api/discoveryReview";
import {
  DiscoveryBatch,
  DiscoveryCandidate,
  ListResponse,
} from "../api/types";

// Queue page tests: the client is a fake at the DiscoveryReviewClient
// interface level; list responses are keyed by the request params so
// filter composition can be asserted exactly.

const batch: DiscoveryBatch = {
  id: 7,
  slug: "candidates-us-full",
  title: "Full domestic set (candidates-us)",
  source: "reassessment",
  source_summary: null,
  record_count: 6817,
  status: "open",
  bundle_sha256: "x",
  ingested_at: "2026-11-20T00:00:00Z",
  counts: {
    by_origin_bucket: {},
    by_image_status: {},
    by_hold_reason: {},
    by_review_status: {},
  },
  review_progress: { total: 6817, decided: 0, pending: 6817, percent_reviewed: 0 },
};

const row = (
  overrides: Partial<DiscoveryCandidate> = {}
): DiscoveryCandidate => ({
  id: 61,
  batch_id: 7,
  candidate_key: "bud-light",
  name: "Bud Light",
  brewery_name: "Budweiser",
  style: "Lager",
  abv: 4.2,
  barcode: "018200530027",
  source: "reassessment",
  origin_bucket: "us_produced",
  image_status: "verified",
  image_status_normalized: "verified",
  image_verified: true,
  hold_reason: null,
  review_status: "pending",
  dedupe_outcome: "no_match",
  matched_beer_id: null,
  ...overrides,
});

const listOf = (
  results: DiscoveryCandidate[],
  total = results.length
): ListResponse<DiscoveryCandidate> => ({
  results,
  pagination: {
    page: 1,
    page_size: 50,
    total_results: total,
    total_pages: Math.max(1, Math.ceil(total / 50)),
  },
});

interface FakeQueue {
  client: DiscoveryReviewClient;
  listCalls: any[];
  decideCalls: { id: number; decision: string; reason?: string }[];
  failIds: Set<number>;
}

const makeFake = (rows: DiscoveryCandidate[]): FakeQueue => {
  const listCalls: any[] = [];
  const decideCalls: FakeQueue["decideCalls"] = [];
  const failIds = new Set<number>();
  const client = {
    listBatches: jest.fn(async () => ({ results: [batch] })),
    listBatchCandidates: jest.fn(async (_id: number, params: any) => {
      listCalls.push(params);
      return listOf(rows, 6817);
    }),
    decideCandidate: jest.fn(async (id: number, input: any) => {
      decideCalls.push({ id, decision: input.decision, reason: input.reason });
      if (failIds.has(id)) {
        throw new Error(`server refused candidate ${id}`);
      }
      return row({ id });
    }),
  } as unknown as DiscoveryReviewClient;
  return { client, listCalls, decideCalls, failIds };
};

const renderQueue = (client: DiscoveryReviewClient) =>
  render(
    <MemoryRouter
      initialEntries={["/admin/discovery/review-queue?batch=7"]}
    >
      <DiscoveryReviewQueuePage client={client} />
    </MemoryRouter>
  );

beforeEach(() => {
  sessionStorage.clear();
});

test("renders the full filtered total and rows with image and status info", async () => {
  const fake = makeFake([
    row(),
    row({ id: 62, name: "Coors Light", image_status_normalized: "none", image_status: "none" }),
  ]);
  renderQueue(fake.client);
  expect(await screen.findByText("Bud Light")).toBeInTheDocument();
  expect(screen.getByText(/6817 candidates in this view/)).toBeInTheDocument();
  expect(screen.getByText(/0\/6817 reviewed/)).toBeInTheDocument();
  expect(screen.getByText(/Image: verified/)).toBeInTheDocument();
  // "No image" also appears as a filter option; the row indicator is
  // one of the matches.
  expect(screen.getAllByText(/No image/).length).toBeGreaterThan(1);
  // Default filter is the actionable server-side query.
  expect(fake.listCalls[0]).toMatchObject({ review_status: "pending" });
  // The Review link carries the queue context into the guided view.
  const links = screen.getAllByRole("link", { name: "Review" });
  expect(links[0].getAttribute("href")).toContain(
    "/admin/discovery/review-queue/61?"
  );
  expect(links[0].getAttribute("href")).toContain("batch=7");
});

test("filter composition maps to the endpoint's own parameters", async () => {
  const fake = makeFake([row()]);
  renderQueue(fake.client);
  await screen.findByText("Bud Light");

  fireEvent.change(screen.getByLabelText("Filter"), {
    target: { value: "attention" },
  });
  await waitFor(() =>
    expect(
      fake.listCalls.some((p) => p.hold_reason === "missing_brewery")
    ).toBe(true)
  );

  fireEvent.change(screen.getByLabelText("Filter"), {
    target: { value: "no_image" },
  });
  await waitFor(() =>
    expect(
      fake.listCalls.some((p) => p.image_status === "none")
    ).toBe(true)
  );

  fireEvent.change(screen.getByLabelText("Filter"), {
    target: { value: "with_image" },
  });
  await waitFor(() =>
    expect(
      fake.listCalls.some((p) => p.image_status === "verified")
    ).toBe(true)
  );
});

test("brewery and style filters are sent to the server and carried to review", async () => {
  const fake = makeFake([row()]);
  renderQueue(fake.client);
  await screen.findByText("Bud Light");
  fireEvent.change(screen.getByLabelText("Brewery"), { target: { value: "Coors" } });
  fireEvent.change(screen.getByLabelText("Style"), { target: { value: "Lager" } });
  await waitFor(() => expect(fake.listCalls.some((p) => p.brewery === "Coors" && p.style === "Lager")).toBe(true));
  const href = (await screen.findAllByRole("link", { name: "Review" }))[0].getAttribute("href");
  expect(href).toContain("brewery=Coors");
  expect(href).toContain("style=Lager");
});

test("bulk hold runs sequentially with per-item outcomes and retries only the failures", async () => {
  const fake = makeFake([
    row(),
    row({ id: 62, name: "Coors Light" }),
    row({ id: 63, name: "Miller Lite" }),
  ]);
  fake.failIds.add(62);
  renderQueue(fake.client);
  await screen.findByText("Bud Light");

  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select Bud Light for bulk action" })
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select Coors Light for bulk action" })
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select Miller Lite for bulk action" })
  );
  // Bulk copy states the limits before anything runs.
  expect(
    screen.getByText(/no bulk Approve, no bulk image decision, and no bulk intent/)
  ).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/Reason \(required/), {
    target: { value: "other" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Hold checked" }));
  // Confirmation summary lists every checked name before executing.
  expect(
    await screen.findByText(/Confirm bulk hold: 3 candidates/)
  ).toBeInTheDocument();
  expect(screen.getByText(/Coors Light \(#62\)/)).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm hold for 3 candidates" })
  );

  expect(await screen.findByText("Bulk results")).toBeInTheDocument();
  expect(screen.getByText(/Bud Light \(#61\) - done/)).toBeInTheDocument();
  expect(
    screen.getByText(/Coors Light \(#62\) - failed: server refused candidate 62/)
  ).toBeInTheDocument();
  expect(fake.decideCalls.map((c) => c.id)).toEqual([61, 62, 63]);
  expect(fake.decideCalls.every((c) => c.decision === "hold")).toBe(true);

  // Retry failed only: exactly one more call, for #62.
  fake.failIds.delete(62);
  fireEvent.click(screen.getByRole("button", { name: "Retry failed only" }));
  await waitFor(() =>
    expect(
      screen.getByText(/Coors Light \(#62\) - done/)
    ).toBeInTheDocument()
  );
  expect(fake.decideCalls.map((c) => c.id)).toEqual([61, 62, 63, 62]);
});

test("bulk retry uses the originally confirmed reason and only the failed ids, even after inputs change", async () => {
  const fake = makeFake([
    row(),
    row({ id: 62, name: "Coors Light" }),
    row({ id: 63, name: "Miller Lite" }),
  ]);
  fake.failIds.add(62);
  renderQueue(fake.client);
  await screen.findByText("Bud Light");

  for (const name of ["Bud Light", "Coors Light", "Miller Lite"]) {
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: `Select ${name} for bulk action`,
      })
    );
  }
  fireEvent.change(screen.getByLabelText(/Reason \(required/), {
    target: { value: "other" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Hold checked" }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Confirm hold for 3 candidates",
    })
  );
  expect(await screen.findByText("Bulk results")).toBeInTheDocument();
  expect(fake.decideCalls.map((c) => c.id)).toEqual([61, 62, 63]);
  expect(fake.decideCalls.every((c) => c.reason === "other")).toBe(true);

  // The reviewer changes the reason input AFTER the partial
  // failure. The retry must still apply the confirmed snapshot:
  // reason "other", failed id 62 only.
  fireEvent.change(screen.getByLabelText(/Reason \(required/), {
    target: { value: "missing_brewery" },
  });
  fake.failIds.delete(62);
  // findByRole, not getByRole: the post-confirm list reload briefly
  // unmounts the outcomes block, so the button can need a moment
  // to reappear.
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry failed only" })
  );
  await waitFor(() =>
    expect(screen.getByText(/Coors Light \(#62\) - done/)).toBeInTheDocument()
  );
  expect(fake.decideCalls.map((c) => c.id)).toEqual([61, 62, 63, 62]);
  expect(fake.decideCalls[3].reason).toBe("other");
  expect(fake.decideCalls[3].decision).toBe("hold");
});

test("an unrecognized image status is shown as unknown, never as no image", async () => {
  const fake = makeFake([
    row({ image_status_normalized: "some_future_status" }),
    row({ id: 62, name: "Coors Light", image_status_normalized: null }),
  ]);
  renderQueue(fake.client);
  expect(await screen.findByText("Bud Light")).toBeInTheDocument();
  expect(screen.getByText(/Image: unknown/)).toBeInTheDocument();
  // null is the server's own not-staged value (see queueFilters).
  expect(screen.getByText(/Image: not staged/)).toBeInTheDocument();
});
