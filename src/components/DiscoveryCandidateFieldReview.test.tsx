import React from "react";
import {
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import DiscoveryCandidateFieldReview from "./DiscoveryCandidateFieldReview";

// The full suite runs many workers on a small VM; give async
// queries room to settle under load, and raise the per-test budget
// so a load-slowed test is not killed by the default 5s timeout.
configure({ asyncUtilTimeout: 5000 });
jest.setTimeout(30000);
// Break the real client -> Firebase import chain; these tests drive
// the component through a stub DiscoveryReviewClient only. The
// ApiError mock matches the real client's shape (status + server
// message) because error preservation is part of the contract.
jest.mock("../api/client", () => ({
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  apiGetBlobUrl: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));

import { ApiError } from "../api/client";

// The staged Bud Light: the production candidate whose collision
// detector reported no_match and whose ABV needs human review.
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
  dedupe_outcome: "no_match",
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

const catalogBeer = {
  id: 42,
  name: "Bud Light",
  brewery: { id: 3, name: "Anheuser-Busch" },
};

const makeClient = (overrides: Record<string, unknown> = {}) =>
  ({
    getReviewIntent: jest.fn(async () => null),
    saveReviewIntent: jest.fn(async (id: number, _rev: unknown, intent: unknown) => ({
      id: 11,
      candidate_id: id,
      intent,
      created_at: "2026-11-24T00:00:00.000Z",
    })),
    searchCatalogBeers: jest.fn(async () => ({
      results: [catalogBeer],
      pagination: { page: 1, page_size: 20, total_results: 1, total_pages: 1 },
    })),
    getCatalogBeer: jest.fn(async () => catalogBeer),
    decideCandidate: jest.fn(async () => ({})),
    ...overrides,
  }) as any;

const renderSection = async (
  client: any,
  cand: any = candidate,
  expectedAbv = "3.2123353678124"
) => {
  render(<DiscoveryCandidateFieldReview candidate={cand} client={client} />);
  // Wait for the intent load to settle and the form to seed from
  // the staged (or saved-intent) values before interacting.
  await screen.findByText(/No review intent saved yet|Saved review intent/);
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Proposed ABV") as HTMLInputElement).value
    ).toBe(expectedAbv)
  );
};

test("with no saved intent the form starts from staged values; detector output is information only", async () => {
  const client = makeClient();
  await renderSection(client);
  expect(screen.getByText("3.2123353678124")).toBeInTheDocument();
  expect(
    (screen.getByLabelText("Proposed ABV") as HTMLInputElement).value
  ).toBe("3.2123353678124");
  expect(
    screen.getByText(/more than 2 decimal places and needs human review/)
  ).toBeInTheDocument();
  // The detector reported no_match; that is displayed as staging
  // information and does not pick a mode or a target.
  expect(screen.getByText(/dedupe outcome no_match/)).toBeInTheDocument();
  expect(
    screen.getByText(/does not choose the review mode/)
  ).toBeInTheDocument();
  expect(
    screen.getByRole("radio", { name: "New beer" })
  ).toBeChecked();
});

test("image_url is read-only with the limitation stated, and never enters the payload", async () => {
  const client = makeClient();
  await renderSection(client);
  expect(screen.queryByLabelText("Proposed Image URL")).toBeNull();
  expect(
    screen.getByText(/Changing the image URL needs a separate audited refetch/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/an approved image hash never carries over to a new URL/)
  ).toBeInTheDocument();
});

test("accept-as-staged: saving unchanged values posts the full new_beer payload and no decision", async () => {
  const client = makeClient();
  await renderSection(client);
  fireEvent.click(
    screen.getByRole("button", { name: "Save review intent (new beer)" })
  );
  await waitFor(() =>
    expect(client.saveReviewIntent).toHaveBeenCalledWith(9, null, {
      mode: "new_beer",
      beer: {
        name: "Bud Light",
        brewery_name: "Anheuser-Busch",
        style: "Lager",
        // The warned precision value is saved exactly as staged:
        // accepting it is the reviewer's explicit choice.
        abv: 3.2123353678124,
        ibu: null,
        barcode: "018200530009",
        description: null,
      },
    })
  );
  expect(
    await screen.findByText(/Review intent saved \(revision 11\)/)
  ).toBeInTheDocument();
  // Saving an intent is not a decision, and vice versa.
  expect(client.decideCandidate).not.toHaveBeenCalled();
});

test("ABV 25 is valid now (no 20 ceiling) and is saved as a number", async () => {
  const client = makeClient();
  await renderSection(client);
  fireEvent.change(screen.getByLabelText("Proposed ABV"), {
    target: { value: "25" },
  });
  expect(screen.queryByText(/ABV must be/)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Save review intent (new beer)" })
  );
  await waitFor(() =>
    expect(client.saveReviewIntent).toHaveBeenCalledWith(
      9,
      null,
      expect.objectContaining({
        mode: "new_beer",
        beer: expect.objectContaining({ abv: 25 }),
      })
    )
  );
});

test("ABV 101 is a hard error and blocks the save", async () => {
  const client = makeClient();
  await renderSection(client);
  fireEvent.change(screen.getByLabelText("Proposed ABV"), {
    target: { value: "101" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save review intent (new beer)" })
  );
  expect(
    await screen.findByText(/ABV must be between 0 and 100/)
  ).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    /Fix the field errors above before saving/
  );
  expect(client.saveReviewIntent).not.toHaveBeenCalled();
});

test("an existing intent is shown, seeds the form, and its id is sent as expected_revision", async () => {
  const existing = {
    id: 7,
    candidate_id: 9,
    intent: {
      mode: "new_beer",
      beer: {
        name: "Bud Light",
        brewery_name: "Anheuser-Busch",
        style: "Lager",
        abv: 4.2,
        ibu: null,
        barcode: "018200530009",
        description: null,
      },
    },
    created_at: "2026-11-24T01:00:00.000Z",
  };
  const client = makeClient({
    getReviewIntent: jest.fn(async () => existing),
  });
  await renderSection(client, candidate, "4.2");
  expect(screen.getByText(/Saved review intent/)).toBeInTheDocument();
  expect(screen.getByText(/revision 7/)).toBeInTheDocument();
  expect(
    (screen.getByLabelText("Proposed ABV") as HTMLInputElement).value
  ).toBe("4.2");
  fireEvent.click(
    screen.getByRole("button", { name: "Save review intent (new beer)" })
  );
  await waitFor(() =>
    expect(client.saveReviewIntent).toHaveBeenCalledWith(
      9,
      7,
      expect.objectContaining({ mode: "new_beer" })
    )
  );
});

test("image-only: reviewer searches, picks, and explicitly confirms a target for a no_match candidate", async () => {
  const client = makeClient();
  await renderSection(client);
  fireEvent.click(
    screen.getByRole("radio", { name: "Image only for an existing beer" })
  );
  fireEvent.change(screen.getByLabelText("Search catalog beers by name"), {
    target: { value: "Bud" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search catalog" }));
  expect(await screen.findByText(/#42 - Bud Light/)).toBeInTheDocument();
  expect(client.searchCatalogBeers).toHaveBeenCalledWith("Bud");
  fireEvent.click(screen.getByRole("button", { name: "Choose as target" }));
  // Picking is not confirming: the save stays disabled until the
  // reviewer explicitly confirms the named beer.
  const saveButton = screen.getByRole("button", {
    name: "Save review intent (image only)",
  });
  expect(saveButton).toBeDisabled();
  expect(
    await screen.findByText(/Image-only target: catalog beer/)
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm target beer #42" })
  );
  expect(saveButton).toBeEnabled();
  fireEvent.click(saveButton);
  await waitFor(() =>
    expect(client.saveReviewIntent).toHaveBeenCalledWith(9, null, {
      mode: "image_only",
      target_beer_id: 42,
    })
  );
  expect(client.decideCandidate).not.toHaveBeenCalled();
});

test("a 409 save switches to a reload-required state and reload refetches the intent", async () => {
  const latest = {
    id: 8,
    candidate_id: 9,
    intent: {
      mode: "new_beer",
      beer: {
        name: "Bud Light",
        brewery_name: "Anheuser-Busch",
        style: "Lager",
        abv: 4.2,
        ibu: null,
        barcode: "018200530009",
        description: null,
      },
    },
    created_at: "2026-11-24T02:00:00.000Z",
  };
  const getReviewIntent = jest
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValue(latest);
  const client = makeClient({
    getReviewIntent,
    saveReviewIntent: jest.fn(async () => {
      throw new ApiError(409, "The review intent changed since it was loaded.");
    }),
  });
  await renderSection(client);
  fireEvent.click(
    screen.getByRole("button", { name: "Save review intent (new beer)" })
  );
  expect(
    await screen.findByText(/revision conflict, 409/)
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Reload review intent" })
  );
  expect(await screen.findByText(/revision 8/)).toBeInTheDocument();
  expect(getReviewIntent.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test("a server 422 surfaces the server's own message", async () => {
  const client = makeClient({
    saveReviewIntent: jest.fn(async () => {
      throw new ApiError(422, "ABV 3.21 is not acceptable for this source.");
    }),
  });
  await renderSection(client);
  fireEvent.click(
    screen.getByRole("button", { name: "Save review intent (new beer)" })
  );
  expect(
    await screen.findByText("ABV 3.21 is not acceptable for this source.")
  ).toBeInTheDocument();
});

test("intent controls are disabled with an explanation when the candidate is not pending", async () => {
  const client = makeClient();
  await renderSection(client, { ...candidate, review_status: "selected" });
  expect(
    screen.getByText(/can be saved only while the candidate is pending/)
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Save review intent (new beer)" })
  ).toBeDisabled();
  expect(
    screen.getByRole("radio", { name: "Image only for an existing beer" })
  ).toBeDisabled();
  expect(client.saveReviewIntent).not.toHaveBeenCalled();
});
