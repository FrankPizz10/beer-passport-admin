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

import DiscoveryExistingBeerPanel from "./DiscoveryExistingBeerPanel";

const baseCandidate = {
  id: 42,
  name: "Bud Light (staged)",
  source: "open_food_facts",
  image_url: "https://images.example.com/bud-origin.png",
  image_source: "open_food_facts",
  image_license: "CC0",
  matched_beer_id: null,
} as any;

const renderPanel = (candidate: any, client: any) =>
  render(
    <MemoryRouter>
      <DiscoveryExistingBeerPanel candidate={candidate} client={client} />
    </MemoryRouter>
  );

test("renders nothing for a candidate with no catalog match", () => {
  const client = { getCatalogBeer: jest.fn() } as any;
  const { container } = renderPanel(baseCandidate, client);
  expect(container).toBeEmptyDOMElement();
  expect(client.getCatalogBeer).not.toHaveBeenCalled();
});

test("names the existing catalog beer explicitly and separates the image decision from import", async () => {
  const client = {
    getCatalogBeer: jest.fn(async () => ({
      id: 7,
      name: "Bud Light",
      brewery: { id: 3, name: "Anheuser-Busch" },
    })),
  } as any;
  renderPanel({ ...baseCandidate, matched_beer_id: 7 }, client);
  expect(await screen.findByText(/#7 - Bud Light/)).toBeInTheDocument();
  expect(screen.getByText("Existing catalog beer")).toBeInTheDocument();
  expect(
    screen.getByText(/records an image decision for catalog beer #7 only/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/does not create or change a beer/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/image-only import path is pending backend support/)
  ).toBeInTheDocument();
  // Provenance: the origin URL is text, and this panel renders no
  // image element at all.
  expect(
    screen.getByText("https://images.example.com/bud-origin.png")
  ).toBeInTheDocument();
  expect(screen.queryByRole("img")).toBeNull();
  expect(client.getCatalogBeer).toHaveBeenCalledWith(7);
});

test("shows an error state when the catalog beer cannot be loaded", async () => {
  const client = {
    getCatalogBeer: jest.fn(async () => {
      throw new Error("catalog unavailable");
    }),
  } as any;
  renderPanel({ ...baseCandidate, matched_beer_id: 7 }, client);
  expect(
    await screen.findByText(/matched catalog beer could not be loaded/)
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});
