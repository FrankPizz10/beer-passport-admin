import { ApiError } from "../../api/client";

jest.mock("../../api/client", () => ({
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
import {
  DiscoveryReviewClient,
  ReviewIntent,
  ReviewIntentRecord,
} from "../../api/discoveryReview";
import {
  DiscoveryCandidateDetail,
  DiscoveryImageDecision,
  DiscoveryImageFetch,
} from "../../api/types";
import { imageEligibility, runApproveFlow } from "./approveFlow";

// A stateful fake DiscoveryReviewClient: writes mutate the fake
// server state exactly the way the real API would (saving an intent
// creates a new revision, deciding a fetch records the decision,
// selecting flips the status), so resume tests can prove no
// duplicate records are ever written.

const makeCandidate = (
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
    ibu: null,
    description: null,
    source_record_id: "rec-61",
    source_url: "https://example.test/bud-light",
    retrieved_at: null,
    tier: null,
    origin_evidence: null,
    image_url: "https://images.example.test/bud-light.jpg",
    image_source: "off",
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
    created_at: "2026-11-20T00:00:00Z",
    updated_at: "2026-11-20T00:00:00Z",
    batch: { id: 7, slug: "candidates-us-full", title: "Full domestic set" },
    pairs: [],
    ...overrides,
  }) as DiscoveryCandidateDetail;

const makeFetch = (
  overrides: Partial<DiscoveryImageFetch> = {}
): DiscoveryImageFetch => ({
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
  ...overrides,
});

const NEW_BEER: ReviewIntent = {
  mode: "new_beer",
  beer: {
    name: "Bud Light",
    brewery_name: "Budweiser",
    style: "Lager",
    abv: 4.2,
    ibu: null,
    barcode: "018200530027",
    description: null,
  },
};

class FakeClient {
  candidate: DiscoveryCandidateDetail;
  intent: ReviewIntentRecord | null = null;
  fetches: DiscoveryImageFetch[] = [];
  imageDecisions: DiscoveryImageDecision[] = [];
  calls: string[] = [];
  failSaveIntent: Error | null = null;
  failDecideImage: Error | null = null;
  failSelect: Error | null = null;
  private intentSeq = 100;

  constructor(candidate: DiscoveryCandidateDetail) {
    this.candidate = candidate;
  }

  asClient(): DiscoveryReviewClient {
    const self = this;
    return {
      getCandidate: jest.fn(async () => {
        self.calls.push("getCandidate");
        return self.candidate;
      }),
      getReviewIntent: jest.fn(async () => {
        self.calls.push("getReviewIntent");
        return self.intent;
      }),
      saveReviewIntent: jest.fn(
        async (
          _id: number,
          expected: number | null,
          intent: ReviewIntent
        ) => {
          self.calls.push("saveReviewIntent");
          if (self.failSaveIntent) throw self.failSaveIntent;
          const current = self.intent ? self.intent.id : null;
          if (expected !== current) {
            throw new ApiError(409, "Intent revision conflict.");
          }
          const record: ReviewIntentRecord = {
            id: ++self.intentSeq,
            candidate_id: self.candidate.id,
            intent,
            created_at: "2026-11-20T02:00:00Z",
          };
          self.intent = record;
          return record;
        }
      ),
      listImageFetches: jest.fn(async () => {
        self.calls.push("listImageFetches");
        return {
          results: self.fetches,
          pagination: { page: 1, page_size: 100, total_results: self.fetches.length, total_pages: 1 },
        };
      }),
      listImageDecisions: jest.fn(async () => {
        self.calls.push("listImageDecisions");
        return {
          results: self.imageDecisions,
          pagination: { page: 1, page_size: 100, total_results: self.imageDecisions.length, total_pages: 1 },
        };
      }),
      decideImage: jest.fn(async (_id: number, input: { fetch_id: number; decision: string; image_sha256?: string }) => {
        self.calls.push("decideImage");
        if (self.failDecideImage) throw self.failDecideImage;
        const fetch = self.fetches.find((f) => f.id === input.fetch_id);
        if (fetch && fetch.decision) {
          throw new ApiError(409, "Fetch already decided.");
        }
        const decision: DiscoveryImageDecision = {
          id: 900 + self.imageDecisions.length,
          candidate_id: self.candidate.id,
          fetch_id: input.fetch_id,
          decision: input.decision,
          image_sha256: input.image_sha256 ?? null,
          note: null,
          decided_by: { id: 1, user_name: "reviewer" },
          decided_at: "2026-11-20T03:00:00Z",
        } as DiscoveryImageDecision;
        self.imageDecisions.push(decision);
        if (fetch) {
          fetch.decision = {
            id: decision.id,
            decision: decision.decision,
            decided_at: decision.decided_at,
          };
        }
        // The real decision POST projects the candidate's current
        // image decision columns in the same transaction.
        self.candidate = {
          ...self.candidate,
          image_decision: input.decision,
          image_decision_fetch_id: input.fetch_id,
        };
        return decision;
      }),
      decideCandidate: jest.fn(async (_id: number, input: { decision: string }) => {
        self.calls.push(`decideCandidate:${input.decision}`);
        if (self.failSelect) throw self.failSelect;
        if (input.decision === "select") {
          self.candidate = { ...self.candidate, review_status: "selected" };
        }
        return self.candidate;
      }),
      getCandidateDecisions: jest.fn(async () => ({
        results: [],
        pagination: { page: 1, page_size: 100, total_results: 0, total_pages: 1 },
      })),
      requestImageFetch: jest.fn(async () => {
        throw new Error("not used");
      }),
      getImagePreviewUrl: jest.fn(async () => "blob:preview"),
      getCatalogBeer: jest.fn(async () => {
        throw new Error("not used");
      }),
      searchCatalogBeers: jest.fn(async () => ({
        results: [],
        pagination: { page: 1, page_size: 20, total_results: 0, total_pages: 1 },
      })),
      listBatches: jest.fn(async () => ({ results: [] })),
      listBatchCandidates: jest.fn(async () => ({
        results: [],
        pagination: { page: 1, page_size: 50, total_results: 0, total_pages: 1 },
      })),
      getManifest: jest.fn(async () => {
        throw new Error("not used");
      }),
      approveManifest: jest.fn(async () => {
        throw new Error("not used");
      }),
      getMatchSuggestions: jest.fn(async () => ({
        candidate_id: 61,
        suggestions: [],
        exhaustive: true,
        scanned: 0,
      })),
    } as unknown as DiscoveryReviewClient;
  }
}

// The snapshot of the standard fixture fetch (id 500, sha 'a'*64)
// as the guided page would pass it after the preview loaded.
const REVIEWED = { fetchId: 500, sha256: "a".repeat(64) };

const runFlow = (fake: FakeClient, intent: ReviewIntent = NEW_BEER) =>
  runApproveFlow({
    client: fake.asClient(),
    candidateId: 61,
    desiredIntent: intent,
    reviewedImage: REVIEWED,
  });

test("full run performs intent, image, select in order", async () => {
  const fake = new FakeClient(makeCandidate());
  fake.fetches = [makeFetch()];
  const result = await runFlow(fake);
  expect(result.ready).toBe(true);
  expect(result.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
  const order = fake.calls.filter((c) =>
    ["saveReviewIntent", "decideImage", "decideCandidate:select"].includes(c)
  );
  expect(order).toEqual([
    "saveReviewIntent",
    "decideImage",
    "decideCandidate:select",
  ]);
});

test("identical saved intent, recorded image decision, and selected status are all skipped", async () => {
  const fake = new FakeClient(
    makeCandidate({
      review_status: "selected",
      image_decision: "approved",
      image_decision_fetch_id: 500,
    })
  );
  fake.intent = {
    id: 5,
    candidate_id: 61,
    intent: NEW_BEER,
    created_at: "2026-11-20T00:30:00Z",
  };
  fake.fetches = [
    makeFetch({
      decision: { id: 9, decision: "approved", decided_at: "2026-11-20T01:30:00Z" },
    }),
  ];
  fake.imageDecisions = [
    {
      id: 9,
      candidate_id: 61,
      fetch_id: 500,
      image_ref: "sha",
      image_sha256: "a".repeat(64),
      image_content_type: "image/jpeg",
      image_width: 400,
      image_height: 400,
      image_source: "off",
      image_license: null,
      decision: "approved",
      note: null,
      decided_by: { id: 1, user_name: "reviewer" },
      decided_at: "2026-11-20T01:30:00Z",
    } as DiscoveryImageDecision,
  ];
  const client = fake.asClient();
  const result = await runApproveFlow({
    client,
    candidateId: 61,
    desiredIntent: NEW_BEER,
    reviewedImage: REVIEWED,
  });
  expect(result.ready).toBe(true);
  expect(result.steps.map((s) => s.status)).toEqual([
    "skipped",
    "done",
    "skipped",
  ]);
  expect(client.saveReviewIntent).not.toHaveBeenCalled();
  expect(client.decideImage).not.toHaveBeenCalled();
  expect(client.decideCandidate).not.toHaveBeenCalled();
});

test("partial failure at the intent step stops the run; resume completes without duplicates", async () => {
  const fake = new FakeClient(makeCandidate());
  fake.fetches = [makeFetch()];
  fake.failSaveIntent = new ApiError(500, "database unavailable");
  const first = await runFlow(fake);
  expect(first.ready).toBe(false);
  expect(first.steps[0].status).toBe("failed");
  expect(first.steps[0].error).toContain("database unavailable");
  expect(first.steps[1].status).toBe("pending");
  expect(first.steps[2].status).toBe("pending");
  expect(fake.calls).not.toContain("decideImage");

  fake.failSaveIntent = null;
  const second = await runFlow(fake);
  expect(second.ready).toBe(true);
  // Exactly one successful save, one image decision, one select.
  expect(fake.imageDecisions).toHaveLength(1);
  expect(
    fake.calls.filter((c) => c === "decideCandidate:select")
  ).toHaveLength(1);
});

test("partial failure at the image step: resume does not re-save the intent or re-decide", async () => {
  const fake = new FakeClient(makeCandidate());
  fake.fetches = [makeFetch()];
  fake.failDecideImage = new ApiError(500, "image store read failed");
  const first = await runFlow(fake);
  expect(first.steps.map((s) => s.status)).toEqual([
    "done",
    "failed",
    "pending",
  ]);

  fake.failDecideImage = null;
  const client = fake.asClient();
  const second = await runApproveFlow({
    client,
    candidateId: 61,
    desiredIntent: NEW_BEER,
    reviewedImage: REVIEWED,
  });
  expect(second.ready).toBe(true);
  expect(second.steps[0].status).toBe("skipped");
  expect(client.saveReviewIntent).not.toHaveBeenCalled();
  expect(fake.imageDecisions).toHaveLength(1);
});

test("partial failure at select: resume runs only the select", async () => {
  const fake = new FakeClient(makeCandidate());
  fake.fetches = [makeFetch()];
  fake.failSelect = new ApiError(409, "Selection is blocked by an unresolved pair.");
  const first = await runFlow(fake);
  expect(first.steps.map((s) => s.status)).toEqual([
    "done",
    "done",
    "failed",
  ]);
  expect(first.steps[2].error).toContain("unresolved pair");

  fake.failSelect = null;
  const second = await runFlow(fake);
  expect(second.ready).toBe(true);
  expect(second.steps[0].status).toBe("skipped");
  expect(second.steps[1].status).toBe("done");
  expect(fake.imageDecisions).toHaveLength(1);
});

test("an already-decided 409 from the image decision is treated as done", async () => {
  const fake = new FakeClient(makeCandidate());
  const fetch = makeFetch();
  fake.fetches = [fetch];
  // Simulate a race: the audit list gains the decision between the
  // state load and the decide call, which then 409s.
  const client = fake.asClient();
  (client.decideImage as jest.Mock).mockImplementation(async () => {
    fake.imageDecisions.push({
      id: 901,
      candidate_id: 61,
      fetch_id: fetch.id,
      decision: "approved",
      image_sha256: fetch.sha256,
      note: null,
      decided_by: { id: 2, user_name: "other" },
      decided_at: "2026-11-20T03:00:00Z",
    } as DiscoveryImageDecision);
    throw new ApiError(409, "Fetch already decided.");
  });
  const result = await runApproveFlow({
    client,
    candidateId: 61,
    desiredIntent: NEW_BEER,
    reviewedImage: REVIEWED,
  });
  expect(result.ready).toBe(true);
  expect(result.steps[1].status).toBe("done");
  expect(result.steps[1].detail).toContain("approved concurrently");
});

test("an intent revision conflict surfaces as a conflict failure", async () => {
  const fake = new FakeClient(makeCandidate());
  fake.failSaveIntent = new ApiError(409, "Intent revision conflict.");
  const result = await runFlow(fake);
  expect(result.ready).toBe(false);
  expect(result.steps[0].status).toBe("failed");
  expect(result.steps[0].conflict).toBe(true);
});

test("no-image new beer skips the image step with a visible note", async () => {
  const fake = new FakeClient(makeCandidate({ image_url: null }));
  const result = await runFlow(fake);
  expect(result.ready).toBe(true);
  expect(result.steps[1].status).toBe("skipped");
  expect(result.steps[1].detail).toContain("does not use a staged image");
});

test("image-only without a viewed preview blocks: an approved image is required and nothing is selected", async () => {
  const fake = new FakeClient(makeCandidate());
  const client = fake.asClient();
  const result = await runApproveFlow({
    client,
    candidateId: 61,
    desiredIntent: { mode: "image_only", target_beer_id: 3784 },
    reviewedImage: null,
  });
  expect(result.ready).toBe(false);
  expect(result.steps[1].status).toBe("blocked");
  expect(result.imageBlock).toBe("no_snapshot");
  expect(client.decideImage).not.toHaveBeenCalled();
  expect(client.decideCandidate).not.toHaveBeenCalled();
});

test("a held candidate fails the select step with an explanation and no select call", async () => {
  const fake = new FakeClient(
    makeCandidate({
      review_status: "held",
      image_decision: "approved",
      image_decision_fetch_id: 500,
    })
  );
  fake.fetches = [
    makeFetch({
      decision: { id: 9, decision: "approved", decided_at: "2026-11-20T01:30:00Z" },
    }),
  ];
  const client = fake.asClient();
  const result = await runApproveFlow({
    client,
    candidateId: 61,
    desiredIntent: NEW_BEER,
    reviewedImage: REVIEWED,
  });
  expect(result.ready).toBe(false);
  expect(result.steps[2].status).toBe("failed");
  expect(result.steps[2].error).toContain("held");
  expect(client.decideCandidate).not.toHaveBeenCalled();
});

// --- Fix pass: approval binds to the reviewed preview ---------------------

const decisionRow = (
  overrides: Partial<DiscoveryImageDecision> = {}
): DiscoveryImageDecision =>
  ({
    id: 900,
    candidate_id: 61,
    fetch_id: 500,
    image_ref: "sha",
    image_sha256: "a".repeat(64),
    image_content_type: "image/jpeg",
    image_width: 400,
    image_height: 400,
    image_source: "off",
    image_license: null,
    decision: "approved",
    note: null,
    decided_by: { id: 1, user_name: "reviewer" },
    decided_at: "2026-11-20T03:00:00Z",
    ...overrides,
  }) as DiscoveryImageDecision;

test("a newer fetch arriving after the preview does not change what gets approved", async () => {
  const fake = new FakeClient(makeCandidate());
  // Fetch 501 landed after the reviewer viewed fetch 500's preview.
  fake.fetches = [
    makeFetch(),
    makeFetch({ id: 501, sha256: "b".repeat(64) }),
  ];
  const client = fake.asClient();
  const result = await runApproveFlow({
    client,
    candidateId: 61,
    desiredIntent: NEW_BEER,
    reviewedImage: REVIEWED,
  });
  expect(result.ready).toBe(true);
  expect(fake.imageDecisions).toHaveLength(1);
  expect(fake.imageDecisions[0].fetch_id).toBe(500);
  expect(fake.imageDecisions[0].image_sha256).toBe("a".repeat(64));
  expect(client.decideImage).toHaveBeenCalledTimes(1);
});

test("preview load failure (no snapshot) blocks the image step: no decision, no selection", async () => {
  const fake = new FakeClient(makeCandidate());
  fake.fetches = [makeFetch()];
  const client = fake.asClient();
  const result = await runApproveFlow({
    client,
    candidateId: 61,
    desiredIntent: NEW_BEER,
    reviewedImage: null,
  });
  expect(result.ready).toBe(false);
  expect(result.steps[1].status).toBe("blocked");
  expect(result.imageBlock).toBe("no_snapshot");
  expect(client.decideImage).not.toHaveBeenCalled();
  expect(client.decideCandidate).not.toHaveBeenCalled();
});

test("a drifted preview (hash changed since viewing) blocks and approves nothing", async () => {
  const fake = new FakeClient(makeCandidate());
  fake.fetches = [makeFetch({ sha256: "b".repeat(64) })];
  const client = fake.asClient();
  const result = await runApproveFlow({
    client,
    candidateId: 61,
    desiredIntent: NEW_BEER,
    reviewedImage: REVIEWED,
  });
  expect(result.ready).toBe(false);
  expect(result.steps[1].status).toBe("blocked");
  expect(result.imageBlock).toBe("drift");
  expect(client.decideImage).not.toHaveBeenCalled();
  expect(client.decideCandidate).not.toHaveBeenCalled();
});

test("a rejected decision on the reviewed fetch is a hard block, never ready", async () => {
  const fake = new FakeClient(
    makeCandidate({ image_decision: "rejected", image_decision_fetch_id: 500 })
  );
  fake.fetches = [
    makeFetch({
      decision: { id: 9, decision: "rejected", decided_at: "2026-11-20T01:30:00Z" },
    }),
  ];
  fake.imageDecisions = [decisionRow({ id: 9, decision: "rejected" })];
  const client = fake.asClient();
  const result = await runApproveFlow({
    client,
    candidateId: 61,
    desiredIntent: NEW_BEER,
    reviewedImage: REVIEWED,
  });
  expect(result.ready).toBe(false);
  expect(result.steps[1].status).toBe("blocked");
  expect(result.imageBlock).toBe("rejected");
  expect(result.steps[1].error).toContain("REJECTED");
  expect(result.steps[1].error).toContain("fetch a new image");
  expect(client.decideImage).not.toHaveBeenCalled();
  expect(client.decideCandidate).not.toHaveBeenCalled();
});

test("a 409 caused by a concurrent REJECTED decision blocks instead of counting as done", async () => {
  const fake = new FakeClient(makeCandidate());
  const fetch = makeFetch();
  fake.fetches = [fetch];
  const client = fake.asClient();
  (client.decideImage as jest.Mock).mockImplementation(async () => {
    fake.imageDecisions.push(decisionRow({ id: 901, decision: "rejected" }));
    throw new ApiError(409, "Fetch already decided.");
  });
  const result = await runApproveFlow({
    client,
    candidateId: 61,
    desiredIntent: NEW_BEER,
    reviewedImage: REVIEWED,
  });
  expect(result.ready).toBe(false);
  expect(result.steps[1].status).toBe("blocked");
  expect(result.imageBlock).toBe("rejected");
  expect(client.decideCandidate).not.toHaveBeenCalled();
});

test("an intent changed by another reviewer stops the run with a conflict and no overwrite", async () => {
  const fake = new FakeClient(makeCandidate());
  fake.fetches = [makeFetch()];
  // This session began from revision 5 (a new_beer intent); the
  // saved intent is now revision 7 with a different choice.
  fake.intent = {
    id: 7,
    candidate_id: 61,
    intent: { mode: "image_only", target_beer_id: 3784 },
    created_at: "2026-11-20T04:00:00Z",
  };
  const client = fake.asClient();
  const result = await runApproveFlow({
    client,
    candidateId: 61,
    desiredIntent: NEW_BEER,
    reviewedImage: REVIEWED,
    baselineIntent: { id: 5, intent: NEW_BEER },
  });
  expect(result.ready).toBe(false);
  expect(result.steps[0].status).toBe("failed");
  expect(result.steps[0].conflict).toBe(true);
  expect(client.saveReviewIntent).not.toHaveBeenCalled();
  expect(client.decideImage).not.toHaveBeenCalled();
  expect(client.decideCandidate).not.toHaveBeenCalled();
  // The other reviewer's intent is untouched.
  expect(fake.intent?.id).toBe(7);
});

test("image-only with no staged image at all is not ready and selects nothing", async () => {
  const fake = new FakeClient(makeCandidate({ image_url: null }));
  const client = fake.asClient();
  const result = await runApproveFlow({
    client,
    candidateId: 61,
    desiredIntent: { mode: "image_only", target_beer_id: 3784 },
    reviewedImage: null,
  });
  expect(result.ready).toBe(false);
  expect(result.steps[1].status).toBe("blocked");
  expect(result.notReadyReasons.join(" ")).toContain(
    "approved_image_required"
  );
  expect(client.decideCandidate).not.toHaveBeenCalled();
});

test("image-only with the reviewed preview approves exactly that fetch and is ready", async () => {
  const fake = new FakeClient(makeCandidate());
  fake.fetches = [makeFetch()];
  const result = await runFlow(fake, {
    mode: "image_only",
    target_beer_id: 3784,
  });
  expect(result.ready).toBe(true);
  expect(fake.imageDecisions).toHaveLength(1);
  expect(fake.imageDecisions[0].fetch_id).toBe(500);
});

describe("imageEligibility mirrors discoveryManifestCore's image rules", () => {
  const base = {
    imageDecisions: [] as DiscoveryImageDecision[],
    fetches: [] as DiscoveryImageFetch[],
  };

  test("new beer with an undecided image is not eligible (image_unverified)", () => {
    const v = imageEligibility({
      mode: "new_beer",
      candidate: makeCandidate(),
      ...base,
    });
    expect(v.ok).toBe(false);
    expect(v.blockers.join(" ")).toContain("image_unverified");
  });

  test("new beer with a rejected image is not eligible (image_rejected)", () => {
    const v = imageEligibility({
      mode: "new_beer",
      candidate: makeCandidate({
        image_decision: "rejected",
        image_decision_fetch_id: 500,
      }),
      ...base,
    });
    expect(v.ok).toBe(false);
    expect(v.blockers.join(" ")).toContain("image_rejected");
  });

  test("new beer with an approved decision and its binding row is eligible", () => {
    const v = imageEligibility({
      mode: "new_beer",
      candidate: makeCandidate({
        image_decision: "approved",
        image_decision_fetch_id: 500,
      }),
      imageDecisions: [decisionRow()],
      fetches: [],
    });
    expect(v.ok).toBe(true);
  });

  test("approved flag without a verifiable binding row is not eligible", () => {
    const v = imageEligibility({
      mode: "new_beer",
      candidate: makeCandidate({
        image_decision: "approved",
        image_decision_fetch_id: 500,
      }),
      ...base,
    });
    expect(v.ok).toBe(false);
    expect(v.blockers.join(" ")).toContain("image_unverified");
  });

  test("new beer with no image at all is eligible with no image decision", () => {
    const v = imageEligibility({
      mode: "new_beer",
      candidate: makeCandidate({ image_url: null }),
      ...base,
    });
    expect(v.ok).toBe(true);
  });

  test("image-only without an image is not eligible (approved_image_required)", () => {
    const v = imageEligibility({
      mode: "image_only",
      candidate: makeCandidate({ image_url: null }),
      ...base,
    });
    expect(v.ok).toBe(false);
    expect(v.blockers.join(" ")).toContain("approved_image_required");
  });
});
