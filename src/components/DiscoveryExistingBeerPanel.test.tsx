import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
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

import DiscoveryExistingBeerPanel from "./DiscoveryExistingBeerPanel";

// Load headroom for the small shared VM (see the field review suite).
jest.setTimeout(30000);

// matched_beer_id is set on this fixture on purpose: the panel must
// be driven by the SAVED image-only intent, never by the detector's
// match alone.
const baseCandidate = {
  id: 42,
  name: "Bud Light (staged)",
  source: "open_food_facts",
  image_url: "https://images.example.com/bud-origin.png",
  image_source: "open_food_facts",
  image_license: "CC0",
  matched_beer_id: 7,
  dedupe_outcome: "catalog_match",
} as any;

const imageOnlyIntent = {
  id: 5,
  candidate_id: 42,
  intent: { mode: "image_only", target_beer_id: 7 },
  created_at: "2026-11-24T00:00:00.000Z",
};

const renderPanel = (candidate: any, client: any) =>
  render(
    <MemoryRouter>
      <DiscoveryExistingBeerPanel candidate={candidate} client={client} />
    </MemoryRouter>
  );

test("renders nothing when no intent is saved, even though the detector matched a beer", async () => {
  const client = {
    getReviewIntent: jest.fn(async () => null),
    getCatalogBeer: jest.fn(),
  } as any;
  const { container } = renderPanel(baseCandidate, client);
  // The intent was consulted and the panel stays absent.
  await waitFor(() => expect(client.getReviewIntent).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
  expect(client.getCatalogBeer).not.toHaveBeenCalled();
});

test("renders nothing for a saved new_beer intent", async () => {
  const client = {
    getReviewIntent: jest.fn(async () => ({
      id: 6,
      candidate_id: 42,
      intent: {
        mode: "new_beer",
        beer: {
          name: "Bud Light",
          brewery_name: "Anheuser-Busch",
          style: "Lager",
          abv: 4.2,
          ibu: null,
          barcode: null,
          description: null,
        },
      },
      created_at: "2026-11-24T00:00:00.000Z",
    })),
    getCatalogBeer: jest.fn(),
  } as any;
  const { container } = renderPanel(baseCandidate, client);
  await waitFor(() => expect(client.getReviewIntent).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
  expect(client.getCatalogBeer).not.toHaveBeenCalled();
});

test("names the intent's target beer explicitly and separates the image decision from import", async () => {
  const client = {
    getReviewIntent: jest.fn(async () => imageOnlyIntent),
    getCatalogBeer: jest.fn(async () => ({
      id: 7,
      name: "Bud Light",
      brewery: { id: 3, name: "Anheuser-Busch" },
    })),
  } as any;
  renderPanel(baseCandidate, client);
  expect(await screen.findByText(/#7 - Bud Light/)).toBeInTheDocument();
  expect(screen.getByText("Existing catalog beer")).toBeInTheDocument();
  expect(
    screen.getByText(/saved review intent targets existing catalog beer/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/records an image decision for catalog beer #7 only/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/does not create or change a beer/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/image reaches the catalog only when a manifest containing this image-only entry/)
  ).toBeInTheDocument();
  expect(screen.queryByText(/pending backend/i)).toBeNull();
  // Provenance: the origin URL is text, and this panel renders no
  // image element at all.
  expect(
    screen.getByText("https://images.example.com/bud-origin.png")
  ).toBeInTheDocument();
  expect(screen.queryByRole("img")).toBeNull();
  expect(client.getCatalogBeer).toHaveBeenCalledWith(7);
});

test("shows an error state when the saved intent cannot be loaded", async () => {
  const client = {
    getReviewIntent: jest.fn(async () => {
      throw new Error("intent store unavailable");
    }),
    getCatalogBeer: jest.fn(),
  } as any;
  renderPanel(baseCandidate, client);
  expect(
    await screen.findByText(/saved review intent could not be loaded/)
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});

test("shows an error state when the target catalog beer cannot be loaded", async () => {
  const client = {
    getReviewIntent: jest.fn(async () => imageOnlyIntent),
    getCatalogBeer: jest.fn(async () => {
      throw new Error("catalog unavailable");
    }),
  } as any;
  renderPanel(baseCandidate, client);
  expect(
    await screen.findByText(/target catalog beer could not be loaded/)
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});
