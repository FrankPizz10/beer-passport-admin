import { apiGet, apiGetBlobUrl, apiPost } from "./client";
import {
  NotYetAvailableError,
  diffCandidateFields,
  getBatchComposition,
  httpDiscoveryReviewClient,
  validateFieldValue,
} from "./discoveryReview";

jest.mock("./client", () => ({
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  apiGetBlobUrl: jest.fn(),
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

test("the two proposed operations throw NotYetAvailableError", () => {
  expect(() =>
    httpDiscoveryReviewClient.saveFieldEdits(9, [
      { field: "abv", original: "3.2123353678124", proposed: "4.2" },
    ])
  ).toThrow(NotYetAvailableError);
  expect(() =>
    httpDiscoveryReviewClient.requestImageOnlyManifest(3)
  ).toThrow(NotYetAvailableError);
});

test("ABV validation: precision is a warning, range and type are errors", () => {
  const precision = validateFieldValue("abv", "3.2123353678124");
  expect(precision?.level).toBe("warning");
  expect(precision?.message).toMatch(/needs human review/);
  expect(validateFieldValue("abv", "25")?.level).toBe("error");
  expect(validateFieldValue("abv", "not-a-number")?.level).toBe("error");
  expect(validateFieldValue("abv", "4.2")).toBeNull();
  expect(validateFieldValue("abv", "")).toBeNull();
});

test("name and brewery are required", () => {
  expect(validateFieldValue("name", "  ")?.level).toBe("error");
  expect(validateFieldValue("brewery_name", "")?.level).toBe("error");
  expect(validateFieldValue("name", "Bud Light")).toBeNull();
});

const candidate = {
  id: 9,
  name: "Bud Light",
  brewery_name: "Anheuser-Busch",
  abv: 3.2123353678124,
  style: "Lager",
  barcode: "018200530009",
  image_url: "https://images.example.com/bud.png",
} as any;

test("diffCandidateFields returns only changed fields, values verbatim", () => {
  const edits = diffCandidateFields(candidate, {
    name: "Bud Light",
    abv: "4.2",
    barcode: "018200530009",
  });
  expect(edits).toEqual([
    { field: "abv", original: "3.2123353678124", proposed: "4.2" },
  ]);
});

test("getBatchComposition pages until the server total is covered", async () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1,
    matched_beer_id: i < 30 ? 500 + i : null,
  }));
  const stub: any = {
    listBatches: jest.fn(async () => ({
      results: [{ id: 3, record_count: 6817 }],
    })),
    listBatchCandidates: jest.fn(async (_batchId: number, params: any) => {
      const page = params.page as number;
      const size = params.page_size as number;
      return {
        results: rows.slice((page - 1) * size, page * size),
        pagination: {
          page,
          page_size: size,
          total_results: rows.length,
          total_pages: 2,
        },
      };
    }),
  };
  const composition = await getBatchComposition(stub, 3);
  expect(stub.listBatchCandidates).toHaveBeenCalledTimes(2);
  expect(composition.totalRecords).toBe(6817);
  expect(composition.selectedCount).toBe(150);
  expect(composition.imageOnlyCount).toBe(30);
  expect(composition.newBeerCount).toBe(120);
});
