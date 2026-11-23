import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ImageQueuePage from "./ImageQueuePage";

// The queue page's quality gate: Approve stays disabled until the
// candidate image has fired a successful load in the reviewer's
// browser; a failed load keeps Approve disabled (Reject stays
// available); a decision posts to the approval endpoint and removes
// the row. Private candidates are previewed through the preview-url
// endpoint. The API client is mocked; no network.
jest.mock("../api/client", () => ({
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  ApiError: class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { apiGet, apiPost } from "../api/client";

const HOSTED_URL = "https://cdn.example.com/beers/hosted-10.jpg";
const SIGNED_URL = "https://signed.example.com/presigned-object?X-Amz-Signature=test";

const hostedItem = {
  id: 10,
  beverage_id: 7,
  beverage: { id: 7, name: "Hosted Beer" },
  brewery: { id: 3, name: "Queue Brewery" },
  source_type: "openfoodfacts",
  source_url: "https://world.openfoodfacts.org/product/123",
  license_type: "CC BY-SA",
  attribution: "Open Food Facts",
  license_url: "https://example.com/license",
  status: "pending",
  source_check_status: "image",
  source_content_type: "image/jpeg",
  source_checked_at: "2026-11-20T00:00:00.000Z",
  image_url: HOSTED_URL,
  has_private_image: false,
  created_at: "2026-11-20T00:00:00.000Z",
};

const privateItem = {
  ...hostedItem,
  id: 9,
  beverage: { id: 8, name: "Private Beer" },
  beverage_id: 8,
  source_check_status: "unchecked",
  source_content_type: null,
  image_url: null,
  has_private_image: true,
};

const decision = {
  id: 5,
  beverage_image_id: 11,
  beverage_id: 12,
  action: "approve",
  from_status: "pending",
  to_status: "approved",
  admin_user_id: 1,
  admin_user_name: "alice",
  note: "Label matches.",
  created_at: "2026-11-21T00:00:00.000Z",
};

const listOf = (results: any[]) => ({
  results,
  pagination: { current_page: 1, total_pages: 1, total_results: results.length, page_size: 100 },
});

const mockApi = (queueItems: any[]) => {
  (apiGet as jest.Mock).mockImplementation((path: string) => {
    if (path === "/images/queue") return Promise.resolve(listOf(queueItems));
    if (path === "/images/decisions") return Promise.resolve(listOf([decision]));
    if (path === "/images/9/preview-url")
      return Promise.resolve({ url: SIGNED_URL, expires_at: "2026-11-21T00:15:00.000Z" });
    return Promise.reject(new Error(`Unexpected path ${path}`));
  });
  (apiPost as jest.Mock).mockResolvedValue({});
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <ImageQueuePage />
    </MemoryRouter>
  );

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ImageQueuePage", () => {
  it("keeps Approve disabled until the hosted image loads, then approves and removes the row", async () => {
    mockApi([hostedItem]);
    renderPage();
    expect(await screen.findByText("Hosted Beer")).toBeInTheDocument();
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    const img = screen.getByAltText("Candidate for Hosted Beer") as HTMLImageElement;
    expect(img.src).toBe(HOSTED_URL);
    fireEvent.load(img);
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/images/10/approve", {}));
    await waitFor(() => expect(screen.queryByText("Hosted Beer")).not.toBeInTheDocument());
  });

  it("shows the failed-load state and keeps Approve disabled on image error, Reject still works", async () => {
    mockApi([hostedItem]);
    renderPage();
    expect(await screen.findByText("Hosted Beer")).toBeInTheDocument();
    const img = screen.getByAltText("Candidate for Hosted Beer");
    fireEvent.error(img);
    expect(await screen.findByText(/Image failed to load/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    const reject = screen.getByRole("button", { name: "Reject" });
    expect(reject).toBeEnabled();
    fireEvent.click(reject);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/images/10/reject", {}));
    await waitFor(() => expect(screen.queryByText("Hosted Beer")).not.toBeInTheDocument());
  });

  it("previews a private candidate through the preview-url endpoint and gates Approve on its load", async () => {
    mockApi([privateItem]);
    renderPage();
    expect(await screen.findByText("Private Beer")).toBeInTheDocument();
    const img = (await screen.findByAltText(
      "Candidate for Private Beer"
    )) as HTMLImageElement;
    expect(apiGet).toHaveBeenCalledWith("/images/9/preview-url");
    expect(img.src).toBe(SIGNED_URL);
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    fireEvent.load(img);
    expect(approve).toBeEnabled();
  });

  it("lists recent decisions with who decided", async () => {
    mockApi([hostedItem]);
    renderPage();
    expect(await screen.findByText("Recent decisions")).toBeInTheDocument();
    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Label matches.")).toBeInTheDocument();
  });
});
