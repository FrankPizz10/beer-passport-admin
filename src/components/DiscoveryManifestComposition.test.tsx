import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
// Break the real client -> Firebase import chain (the composition
// component itself is synchronous over the manifest prop).
jest.mock("../api/client", () => ({
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  apiGetBlobUrl: jest.fn(),
  ApiError: class ApiError extends Error {
    status = 0;
  },
}));

import DiscoveryManifestComposition from "./DiscoveryManifestComposition";

const SHA = "ab".repeat(32);

const manifestWith = (records: unknown[]) =>
  ({
    id: "mf-candidates-us-full-20261124-01",
    batch_id: 3,
    record_count: (records as unknown[]).length,
    sha256: SHA,
    records,
  }) as any;

const renderComposition = (manifest: any) =>
  render(
    <MemoryRouter>
      <DiscoveryManifestComposition manifest={manifest} />
    </MemoryRouter>
  );

test("composition derives from the manifest records' kinds (mixed version 2)", () => {
  renderComposition(
    manifestWith([
      { candidate_id: 11, candidate_key: "off:1", kind: "new_beer", image: null },
      // Version 1 style record: no kind at all, still a new beer.
      { candidate_id: 12, candidate_key: "off:2", image: null },
      {
        candidate_id: 42,
        candidate_key: "off:3",
        kind: "image_only",
        target_beer_id: 7,
        image: {
          decision_id: 9,
          fetch_id: 51,
          ref: "https://images.example/bud.png",
          sha256: "a".repeat(64),
        },
      },
    ])
  );
  expect(
    screen.getByText(/New beers: 2 records/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Image-only records: 1/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/image for existing catalog beer #7/)
  ).toBeInTheDocument();
  expect(screen.getByText("Image only")).toBeInTheDocument();
  // The section names the exact manifest ID and full SHA-256 it
  // covers, and image-only entries are described as part of the
  // manifest (the shipped behavior), never as pending support.
  expect(
    screen.getByText(new RegExp(`manifest mf-candidates-us-full-20261124-01, sha256 ${SHA}`))
  ).toBeInTheDocument();
  expect(
    screen.getByText(/are part of this manifest/)
  ).toBeInTheDocument();
  expect(screen.queryByText(/pending backend/i)).toBeNull();
  expect(screen.queryByText(/not yet deployed/i)).toBeNull();
});

test("a version 1 manifest (no kind anywhere) renders as all new beers", () => {
  renderComposition(
    manifestWith([
      { candidate_id: 11, candidate_key: "off:1", image: null },
      { candidate_id: 12, candidate_key: "off:2", image: null },
    ])
  );
  expect(screen.getByText(/New beers: 2 records/)).toBeInTheDocument();
  expect(screen.getByText(/Image-only records: 0/)).toBeInTheDocument();
  expect(
    screen.getByText(/No image-only records in this manifest/)
  ).toBeInTheDocument();
});

test("empty state when the manifest has no records", () => {
  renderComposition(manifestWith([]));
  expect(
    screen.getByText(/This manifest contains no records/)
  ).toBeInTheDocument();
});
