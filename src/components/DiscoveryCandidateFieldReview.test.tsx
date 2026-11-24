import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DiscoveryCandidateFieldReview from "./DiscoveryCandidateFieldReview";
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

import { NotYetAvailableError } from "../api/discoveryReview";

const candidate = {
  id: 9,
  batch_id: 3,
  candidate_key: "off:018200530009",
  name: "Bud Light",
  brewery_name: "Anheuser-Busch",
  style: "Lager",
  abv: 3.2123353678124,
  barcode: "018200530009",
  source: "open_food_facts",
  origin_bucket: "us_produced",
  image_status: null,
  image_status_normalized: null,
  image_verified: null,
  hold_reason: null,
  review_status: "pending",
  dedupe_outcome: "new",
  matched_beer_id: null,
  ibu: null,
  description: null,
  source_record_id: "018200530009",
  source_url: null,
  retrieved_at: null,
  tier: null,
  origin_evidence: null,
  image_url: "https://images.example.com/bud.png",
  image_source: "open_food_facts",
  image_tier: null,
  image_flag_reason: null,
  image_license: null,
  image_page_url: null,
  image_width: null,
  image_height: null,
  hold_note: null,
  duplicate_of_candidate_id: null,
  image_decision: null,
  image_decision_fetch_id: null,
  image_decision_at: null,
  created_at: "2026-11-23T00:00:00.000Z",
  updated_at: "2026-11-23T00:00:00.000Z",
  batch: { id: 3, slug: "candidates-us-full", title: "Full domestic set" },
  pairs: [],
} as any;

const makeClient = (overrides: Record<string, unknown> = {}) =>
  ({
    saveFieldEdits: jest.fn(async () => {
      throw new NotYetAvailableError("Candidate field edits");
    }),
    ...overrides,
  }) as any;

test("read mode shows the staged ABV verbatim with a precision warning", () => {
  render(<DiscoveryCandidateFieldReview candidate={candidate} client={makeClient()} />);
  // Original and proposed columns both show the staged value verbatim.
  expect(screen.getAllByText("3.2123353678124").length).toBeGreaterThanOrEqual(2);
  expect(
    screen.getByText(/more than 2 decimal places and needs human review/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Field edits are pending the review API/)
  ).toBeInTheDocument();
});

test("the diff lists only changed fields", () => {
  render(<DiscoveryCandidateFieldReview candidate={candidate} client={makeClient()} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit fields" }));
  fireEvent.change(screen.getByLabelText("Proposed Name"), {
    target: { value: "Bud Light Lager" },
  });
  expect(screen.getByText("Changed fields (1)")).toBeInTheDocument();
  expect(
    screen.getByText(/Name: Bud Light -> Bud Light Lager/)
  ).toBeInTheDocument();
});

test("an out-of-range ABV is a hard error and blocks the save call", async () => {
  const client = makeClient();
  render(<DiscoveryCandidateFieldReview candidate={candidate} client={client} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit fields" }));
  fireEvent.change(screen.getByLabelText("Proposed ABV"), {
    target: { value: "25" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save field edits" }));
  expect(
    await screen.findByText(/ABV must be between 0 and 20/)
  ).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    /Fix the field errors above before saving/
  );
  expect(client.saveFieldEdits).not.toHaveBeenCalled();
});

test("clearing the name is a hard error and blocks the save call", async () => {
  const client = makeClient();
  render(<DiscoveryCandidateFieldReview candidate={candidate} client={client} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit fields" }));
  fireEvent.change(screen.getByLabelText("Proposed Name"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save field edits" }));
  expect(await screen.findByText(/Name is required/)).toBeInTheDocument();
  expect(client.saveFieldEdits).not.toHaveBeenCalled();
});

test("a high-precision ABV warns, is never auto-corrected, and saving surfaces the pending-API state", async () => {
  const client = makeClient();
  const precise = { ...candidate, abv: 4.2 };
  render(<DiscoveryCandidateFieldReview candidate={precise} client={client} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit fields" }));
  const abvInput = screen.getByLabelText("Proposed ABV") as HTMLInputElement;
  fireEvent.change(abvInput, { target: { value: "3.2123353678124" } });
  expect(
    screen.getByText(/never auto-corrected/)
  ).toBeInTheDocument();
  expect(abvInput.value).toBe("3.2123353678124");
  fireEvent.click(screen.getByRole("button", { name: "Save field edits" }));
  await waitFor(() =>
    expect(client.saveFieldEdits).toHaveBeenCalledWith(9, [
      { field: "abv", original: "4.2", proposed: "3.2123353678124" },
    ])
  );
  expect(
    await screen.findByText(/Saving field edits is pending the review API/)
  ).toBeInTheDocument();
});
