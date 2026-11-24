import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DiscoveryImageReviewPanel from "./DiscoveryImageReviewPanel";
import { apiGet, apiGetBlobUrl, apiPost } from "../api/client";

jest.mock("../api/client", () => ({
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

const SHA = "a".repeat(64);

const candidate: any = {
  id: 9,
  name: "Alpha Ale",
  image_url: "https://images.example.com/alpha.png",
  image_status: "verified-by-review",
  image_source: "wikimedia_commons",
  image_license: "CC0",
  image_decision: null,
  image_decision_fetch_id: null,
  image_decision_at: null,
};

const successFetch = {
  id: 51,
  candidate_id: 9,
  image_ref: "https://images.example.com/alpha.png",
  sha256: SHA,
  content_type: "image/png",
  byte_size: 1234,
  width: 640,
  height: 480,
  outcome: "success",
  outcome_detail: null,
  fetched_by: { id: 1, user_name: "Admin One" },
  fetched_at: "2026-11-23T12:00:00.000Z",
  decision: null,
};

const failedFetch = {
  ...successFetch,
  id: 52,
  sha256: null,
  content_type: null,
  byte_size: null,
  width: null,
  height: null,
  outcome: "dns_blocked",
  outcome_detail: "Address 10.0.0.5 for images.example.com is blocked: private range 10.0.0.0/8.",
};

const listOf = (results: unknown[]) => ({
  results,
  pagination: { page: 1, page_size: 100, total_results: results.length, total_pages: 1 },
});

const mockGets = (fetches: unknown[], decisions: unknown[] = []) => {
  mockApiGet.mockImplementation((path: string) => {
    if (path.includes("/image-fetches")) return Promise.resolve(listOf(fetches));
    if (path.includes("/image-decisions")) return Promise.resolve(listOf(decisions));
    // The existing-beer panel consults the saved review intent;
    // this suite's candidates have none.
    if (path.includes("/review-intent")) return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockApiGetBlobUrl.mockResolvedValue("blob:preview-url");
  mockApiPost.mockResolvedValue({});
});

test("no fetch yet: shows provenance as text, the fetch button, and no image element", async () => {
  mockGets([]);
  render(<DiscoveryImageReviewPanel candidate={candidate} />);
  expect(await screen.findByText("No image decisions recorded yet")).toBeInTheDocument();
  // The staged URL is provenance text, never an img source or a link.
  expect(screen.getByText("https://images.example.com/alpha.png")).toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Fetch image for review" })
  ).toBeEnabled();
});

test("fetch button posts to the fetch endpoint and surfaces a rate-limit error", async () => {
  mockGets([]);
  const { ApiError } = jest.requireMock("../api/client");
  mockApiPost.mockRejectedValueOnce(
    new ApiError(429, "Image fetch rate limit reached (30 per reviewer per hour). Try again later.")
  );
  render(<DiscoveryImageReviewPanel candidate={candidate} />);
  fireEvent.click(await screen.findByRole("button", { name: "Fetch image for review" }));
  await waitFor(() =>
    expect(mockApiPost).toHaveBeenCalledWith("/discovery/candidates/9/image-fetches", {})
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(/rate limit reached/);
});

test("image store unset: the fetch refusal renders the actionable unavailable state and keeps provenance", async () => {
  mockGets([]);
  const { ApiError } = jest.requireMock("../api/client");
  mockApiPost.mockRejectedValueOnce(
    new ApiError(503, "DISCOVERY_IMAGE_STORE is unset: the server cannot store fetched images.")
  );
  render(<DiscoveryImageReviewPanel candidate={candidate} />);
  fireEvent.click(await screen.findByRole("button", { name: "Fetch image for review" }));
  // The dedicated unavailable state names the configuration
  // problem, says who fixes it, and shows the server's own words.
  expect(
    await screen.findByText(/server image store is not configured/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/administrator must configure the store on the server/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/DISCOVERY_IMAGE_STORE is unset/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/not fetch or upload the origin URL yourself/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Image approve\/reject stays disabled until a stored preview exists/)
  ).toBeInTheDocument();
  // Provenance remains visible as text; no preview is faked and no
  // decision controls are offered.
  expect(screen.getByText("https://images.example.com/alpha.png")).toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Approve image" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Reject image" })).not.toBeInTheDocument();
});

test("failed fetch state: outcome and detail are surfaced, no preview, no decide controls", async () => {
  mockGets([failedFetch]);
  render(<DiscoveryImageReviewPanel candidate={candidate} />);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/dns_blocked/);
  expect(alert).toHaveTextContent(/private range/);
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Approve image" })).not.toBeInTheDocument();
  expect(mockApiGetBlobUrl).not.toHaveBeenCalled();
});

test("preview ready: preview comes only from the preview endpoint, hash shown, approve unlocks after load and posts the binding decision", async () => {
  mockGets([successFetch]);
  render(<DiscoveryImageReviewPanel candidate={candidate} />);
  const img = await screen.findByRole("img");
  // The img source is the blob URL minted from the preview endpoint,
  // never the origin URL.
  expect(mockApiGetBlobUrl).toHaveBeenCalledWith("/discovery/image-fetches/51/preview");
  expect(img).toHaveAttribute("src", "blob:preview-url");
  expect(img.getAttribute("src")).not.toContain("images.example.com");
  expect(screen.getByText("aaaaaaaaaaaa…")).toBeInTheDocument();
  expect(screen.getByText("image/png")).toBeInTheDocument();
  expect(screen.getByText("640 x 480")).toBeInTheDocument();

  const approve = screen.getByRole("button", { name: "Approve image" });
  expect(approve).toBeDisabled();
  expect(screen.getByText(/unlock once the preview image has loaded/)).toBeInTheDocument();
  fireEvent.load(img);
  await waitFor(() => expect(approve).toBeEnabled());

  fireEvent.click(approve);
  await waitFor(() =>
    expect(mockApiPost).toHaveBeenCalledWith("/discovery/candidates/9/image-decisions", {
      fetch_id: 51,
      decision: "approved",
      image_sha256: SHA,
    })
  );
});

test("decided fetch: controls are replaced by the already-decided explanation and history shows the decision", async () => {
  const decidedFetch = {
    ...successFetch,
    decision: { id: 71, decision: "approved", decided_at: "2026-11-23T12:30:00.000Z" },
  };
  const decisionRow = {
    id: 71,
    candidate_id: 9,
    fetch_id: 51,
    image_ref: successFetch.image_ref,
    image_sha256: SHA,
    image_content_type: "image/png",
    image_width: 640,
    image_height: 480,
    image_source: "wikimedia_commons",
    image_license: "CC0",
    decision: "approved",
    note: null,
    decided_by: { id: 1, user_name: "Admin One" },
    decided_at: "2026-11-23T12:30:00.000Z",
  };
  mockGets([decidedFetch], [decisionRow]);
  render(<DiscoveryImageReviewPanel candidate={candidate} />);
  const img = await screen.findByRole("img");
  fireEvent.load(img);
  expect(await screen.findByText(/already decided \(approved\)/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approve image" })).toBeDisabled();
  expect(screen.getByText(/Decided: approved/)).toBeInTheDocument();
});

test("an older fetch can be previewed but not decided when a newer fetch exists", async () => {
  const newer = { ...successFetch, id: 53 };
  mockGets([newer, successFetch]);
  render(<DiscoveryImageReviewPanel candidate={candidate} />);
  // The newest fetch is previewed by default.
  expect(await screen.findByRole("img")).toBeInTheDocument();
  expect(mockApiGetBlobUrl).toHaveBeenCalledWith("/discovery/image-fetches/53/preview");
  // Switch to the older fetch.
  const previewButtons = screen.getAllByRole("button", { name: "Preview" });
  fireEvent.click(previewButtons[0]);
  await waitFor(() =>
    expect(mockApiGetBlobUrl).toHaveBeenCalledWith("/discovery/image-fetches/51/preview")
  );
  const img = await screen.findByRole("img");
  fireEvent.load(img);
  expect(await screen.findByText(/A newer successful fetch exists/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approve image" })).toBeDisabled();
});
