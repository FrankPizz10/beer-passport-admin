import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
// Break the real client -> Firebase import chain; these tests drive
// the components through stub DiscoveryReviewClient props only.
jest.mock("../api/client", () => ({
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  apiGetBlobUrl: jest.fn(),
  ApiError: class ApiError extends Error {
    status = 0;
  },
}));

import DiscoveryManifestComposition from "./DiscoveryManifestComposition";

const manifest = {
  id: "mf-candidates-us-full-20261123-01",
  batch_id: 3,
  record_count: 2,
} as any;

const selected = [
  { id: 11, name: "New Ale", matched_beer_id: null },
  { id: 12, name: "New Lager", matched_beer_id: null },
  { id: 42, name: "Bud Light (staged)", matched_beer_id: 7 },
];

const makeClient = (overrides: Record<string, unknown> = {}) =>
  ({
    listBatches: jest.fn(async () => ({
      results: [{ id: 3, record_count: 6817 }],
    })),
    listBatchCandidates: jest.fn(async () => ({
      results: selected,
      pagination: {
        page: 1,
        page_size: 100,
        total_results: selected.length,
        total_pages: 1,
      },
    })),
    ...overrides,
  }) as any;

const renderComposition = (client: any) =>
  render(
    <MemoryRouter>
      <DiscoveryManifestComposition manifest={manifest} client={client} />
    </MemoryRouter>
  );

test("splits new beers in the manifest from image-only candidates in the batch", async () => {
  renderComposition(makeClient());
  expect(
    await screen.findByText(/New beers in this manifest: 2 records/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Selected in batch: 3 of 6817 staged records/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Image-only candidates \(existing catalog beer, image only\): 1/)
  ).toBeInTheDocument();
  expect(screen.getByText("Pending backend support")).toBeInTheDocument();
  expect(screen.getByText(/not part of this manifest/)).toBeInTheDocument();
  expect(
    screen.getByText(/builder currently refuses selected candidates/)
  ).toBeInTheDocument();
});

test("empty state when nothing in the batch is selected", async () => {
  const client = makeClient({
    listBatchCandidates: jest.fn(async () => ({
      results: [],
      pagination: {
        page: 1,
        page_size: 100,
        total_results: 0,
        total_pages: 0,
      },
    })),
  });
  renderComposition(client);
  expect(
    await screen.findByText(/No candidates in this batch are selected yet/)
  ).toBeInTheDocument();
});

test("empty state for image-only when no selected candidate matched a beer", async () => {
  const client = makeClient({
    listBatchCandidates: jest.fn(async () => ({
      results: selected.slice(0, 2),
      pagination: {
        page: 1,
        page_size: 100,
        total_results: 2,
        total_pages: 1,
      },
    })),
  });
  renderComposition(client);
  expect(
    await screen.findByText(/No image-only records in this batch/)
  ).toBeInTheDocument();
});

test("error state with retry when the composition cannot be loaded", async () => {
  const client = makeClient({
    listBatches: jest.fn(async () => {
      throw new Error("batches unavailable");
    }),
  });
  renderComposition(client);
  expect(
    await screen.findByText(/batch composition could not be loaded/)
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});
