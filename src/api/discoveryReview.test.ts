import { ApiError, apiGet, apiGetBlobUrl, apiPost } from "./client";
import {
  buildNewBeerIntent,
  diffCandidateFields,
  getManifestComposition,
  httpDiscoveryReviewClient,
  isReviewIntentConflict,
  validateFieldValue,
} from "./discoveryReview";

jest.mock("./client", () => ({
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  apiGetBlobUrl: jest.fn(),
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
const mockApiGetBlobUrl = apiGetBlobUrl as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockApiGet.mockResolvedValue({});
  mockApiPost.mockResolvedValue({});
  mockApiGetBlobUrl.mockResolvedValue("blob:preview");
});

test("decideCandidate posts the decision to the existing endpoint", async () => {
  await httpDiscoveryReviewClient.decideCandidate(9, {
    decision: "hold",
    reason: "other",
    note: "needs a second look",
  });
  expect(mockApiPost).toHaveBeenCalledWith("/discovery/candidates/9/decide", {
    decision: "hold",
    reason: "other",
    note: "needs a second look",
  });
});

test("decideImage posts the hash-bound body to the existing endpoint", async () => {
  await httpDiscoveryReviewClient.decideImage(9, {
    fetch_id: 51,
    decision: "approved",
    image_sha256: "a".repeat(64),
  });
  expect(mockApiPost).toHaveBeenCalledWith(
    "/discovery/candidates/9/image-decisions",
    { fetch_id: 51, decision: "approved", image_sha256: "a".repeat(64) }
  );
});

test("getImagePreviewUrl reads stored bytes from the preview endpoint only", async () => {
  await httpDiscoveryReviewClient.getImagePreviewUrl(51);
  expect(mockApiGetBlobUrl).toHaveBeenCalledWith(
    "/discovery/image-fetches/51/preview"
  );
});

test("approveManifest posts exactly the supplied sha256", async () => {
  const sha = "b".repeat(64);
  await httpDiscoveryReviewClient.approveManifest("mf-x-20261123-01", sha);
  expect(mockApiPost).toHaveBeenCalledWith(
    "/discovery/manifests/mf-x-20261123-01/approve",
    { sha256: sha }
  );
});

test("searchCatalogBeers uses the existing catalog list endpoint with q", async () => {
  await httpDiscoveryReviewClient.searchCatalogBeers("Bud");
  expect(mockApiGet).toHaveBeenCalledWith("/catalog/beers", {
    q: "Bud",
    page_size: 20,
  });
});

// --- Review intent (contract section B1) ---

test("getReviewIntent reads the intent endpoint and passes null through", async () => {
  mockApiGet.mockResolvedValue(null);
  await expect(httpDiscoveryReviewClient.getReviewIntent(9)).resolves.toBeNull();
  expect(mockApiGet).toHaveBeenCalledWith(
    "/discovery/candidates/9/review-intent"
  );
});

test("saveReviewIntent posts expected_revision and a new_beer intent", async () => {
  const intent = {
    mode: "new_beer",
    beer: {
      name: "Bud Light",
      brewery_name: "Anheuser-Busch",
      style: "Lager",
      abv: 3.2123353678124,
      ibu: null,
      barcode: "018200530009",
      description: null,
    },
  } as const;
  await httpDiscoveryReviewClient.saveReviewIntent(9, null, intent);
  expect(mockApiPost).toHaveBeenCalledWith(
    "/discovery/candidates/9/review-intent",
    { expected_revision: null, intent }
  );
});

test("saveReviewIntent posts an image_only intent with the last returned id", async () => {
  const intent = { mode: "image_only", target_beer_id: 42 } as const;
  await httpDiscoveryReviewClient.saveReviewIntent(9, 7, intent);
  expect(mockApiPost).toHaveBeenCalledWith(
    "/discovery/candidates/9/review-intent",
    { expected_revision: 7, intent }
  );
});

test("server errors are preserved: status and message reach the caller", async () => {
  mockApiPost.mockRejectedValue(
    new ApiError(422, "ABV 3.21 is not acceptable for this source.")
  );
  const failure = await httpDiscoveryReviewClient
    .saveReviewIntent(9, null, { mode: "image_only", target_beer_id: 42 })
    .catch((e) => e);
  expect(failure).toBeInstanceOf(ApiError);
  expect(failure.status).toBe(422);
  expect(failure.message).toBe("ABV 3.21 is not acceptable for this source.");
  expect(isReviewIntentConflict(failure)).toBe(false);
});

test("a 409 from saveReviewIntent is distinguishable as a revision conflict", async () => {
  mockApiPost.mockRejectedValue(
    new ApiError(409, "The review intent was changed by another save.")
  );
  const failure = await httpDiscoveryReviewClient
    .saveReviewIntent(9, 3, { mode: "image_only", target_beer_id: 42 })
    .catch((e) => e);
  expect(isReviewIntentConflict(failure)).toBe(true);
  expect(isReviewIntentConflict(new Error("boom"))).toBe(false);
  expect(isReviewIntentConflict(null)).toBe(false);
});

// --- Validation ---

test("ABV validation: precision warns; the range is 0 to 100", () => {
  const precision = validateFieldValue("abv", "3.2123353678124");
  expect(precision?.level).toBe("warning");
  expect(precision?.message).toMatch(/needs human review/);
  // No 20% ceiling: values the old UI refused are valid now.
  expect(validateFieldValue("abv", "25")).toBeNull();
  expect(validateFieldValue("abv", "100")).toBeNull();
  expect(validateFieldValue("abv", "101")?.level).toBe("error");
  expect(validateFieldValue("abv", "101")?.message).toMatch(
    /between 0 and 100/
  );
  expect(validateFieldValue("abv", "-1")?.level).toBe("error");
  expect(validateFieldValue("abv", "not-a-number")?.level).toBe("error");
  expect(validateFieldValue("abv", "4.2")).toBeNull();
  expect(validateFieldValue("abv", "")).toBeNull();
});

test("name and brewery are required; IBU must be numeric when present", () => {
  expect(validateFieldValue("name", "  ")?.level).toBe("error");
  expect(validateFieldValue("brewery_name", "")?.level).toBe("error");
  expect(validateFieldValue("name", "Bud Light")).toBeNull();
  expect(validateFieldValue("ibu", "lots")?.level).toBe("error");
  expect(validateFieldValue("ibu", "55")).toBeNull();
  expect(validateFieldValue("ibu", "")).toBeNull();
});

const candidate = {
  id: 9,
  name: "Bud Light",
  brewery_name: "Anheuser-Busch",
  abv: 3.2123353678124,
  style: "Lager",
  ibu: null,
  barcode: "018200530009",
  description: null,
  image_url: "https://images.example.com/bud.png",
} as any;

test("diffCandidateFields returns only changed editable fields, values verbatim", () => {
  const edits = diffCandidateFields(candidate, {
    name: "Bud Light",
    abv: "4.2",
    barcode: "018200530009",
    // image_url is read-only: even a differing form value is not a diff.
    image_url: "https://images.example.com/other.png",
  });
  expect(edits).toEqual([
    { field: "abv", original: "3.2123353678124", proposed: "4.2" },
  ]);
});

test("buildNewBeerIntent supplies all seven fields, nulls for missing optionals, and no image_url", () => {
  const intent = buildNewBeerIntent({
    name: " Bud Light ",
    brewery_name: "Anheuser-Busch",
    style: "Lager",
    abv: "3.2123353678124",
    ibu: "",
    barcode: "018200530009",
    description: "",
    image_url: "https://images.example.com/bud.png",
  });
  expect(intent).toEqual({
    mode: "new_beer",
    beer: {
      name: "Bud Light",
      brewery_name: "Anheuser-Busch",
      style: "Lager",
      abv: 3.2123353678124,
      ibu: null,
      barcode: "018200530009",
      description: null,
    },
  });
  expect(JSON.stringify(intent)).not.toContain("image_url");
});

// --- Manifest composition (from manifest records, never matching) ---

const manifestWith = (records: unknown[]) =>
  ({ id: "mf-x-20261124-01", records }) as any;

test("composition counts version 2 kinds from the manifest records", () => {
  const composition = getManifestComposition(
    manifestWith([
      { candidate_id: 11, kind: "new_beer", image: null },
      // No kind at all: a version 1 record, still a new beer.
      { candidate_id: 12, image: null },
      {
        candidate_id: 42,
        kind: "image_only",
        target_beer_id: 7,
        image: { decision_id: 9, fetch_id: 51, ref: "x", sha256: "a".repeat(64) },
      },
    ])
  );
  expect(composition.totalRecords).toBe(3);
  expect(composition.newBeerCount).toBe(2);
  expect(composition.imageOnlyCount).toBe(1);
  expect(composition.imageOnly[0].target_beer_id).toBe(7);
});

test("a version 1 manifest (no kind anywhere) is all new beers", () => {
  const composition = getManifestComposition(
    manifestWith([
      { candidate_id: 11, image: null },
      { candidate_id: 12, image: null },
    ])
  );
  expect(composition.newBeerCount).toBe(2);
  expect(composition.imageOnlyCount).toBe(0);
});
