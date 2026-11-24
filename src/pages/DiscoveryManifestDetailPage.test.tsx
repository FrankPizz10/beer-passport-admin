import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import DiscoveryManifestDetailPage from "./DiscoveryManifestDetailPage";
import { apiGet, apiGetBlobUrl, apiPost } from "../api/client";

jest.mock("../api/client", () => ({
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

const SHA = "ab".repeat(32);

const detail = (overrides: Record<string, unknown> = {}) => ({
  id: "mf-seed-batch-20261123-01",
  batch_id: 3,
  batch_slug: "seed-batch",
  record_count: 2,
  status: "draft",
  sha256: SHA,
  sha256_short: SHA.slice(0, 12),
  built_by: { id: 1, user_name: "Admin One" },
  approved_by: null,
  approved_at: null,
  approved_sha256: null,
  imported_at: null,
  created_at: "2026-11-23T10:00:00.000Z",
  can_approve: true,
  bundle_sha256: "cd".repeat(32),
  catalog_fingerprint: {
    beers: { count: 5894, md5: "e".repeat(32) },
    breweries: { count: 1339, md5: "f".repeat(32) },
    beverage_images: { count: 0, md5: "0".repeat(32) },
  },
  records: [
    {
      candidate_id: 11,
      candidate_key: "off:1",
      payload_sha256: "1".repeat(64),
      selection_decision_id: 5,
      beer_name: "Test Ale",
      brewery_name: "Acme Brewing",
      brewery: { mode: "new" },
      style: { mode: "existing", style_id: 9, category_id: 2 },
      image: null,
    },
    {
      candidate_id: 12,
      candidate_key: "off:2",
      payload_sha256: "2".repeat(64),
      selection_decision_id: 6,
      beer_name: "Image Lager",
      brewery_name: "Acme Brewing",
      brewery: { mode: "existing", brewery_id: 4 },
      style: { mode: "none" },
      image: {
        decision_id: 9,
        fetch_id: 51,
        ref: "https://images.example/lager.png",
        sha256: "3".repeat(64),
      },
    },
  ],
  events: [
    {
      id: 1,
      manifest_id: "mf-seed-batch-20261123-01",
      action: "build",
      from_status: null,
      to_status: "draft",
      note: null,
      actor: { id: 1, user_name: "Admin One" },
      created_at: "2026-11-23T10:00:00.000Z",
    },
  ],
  ...overrides,
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/admin/discovery/manifests/mf-seed-batch-20261123-01"]}>
      <Routes>
        <Route
          path="/admin/discovery/manifests/:id"
          element={<DiscoveryManifestDetailPage />}
        />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  jest.clearAllMocks();
});

test("draft detail shows the full hash, fingerprint, records, and the approve control for the allowlisted account", async () => {
  mockApiGet.mockResolvedValue(detail());
  renderPage();
  expect(
    await screen.findByText("mf-seed-batch-20261123-01")
  ).toBeInTheDocument();
  expect(screen.getByText(SHA)).toBeInTheDocument();
  expect(screen.getByText(/beers: 5894 rows/)).toBeInTheDocument();
  expect(screen.getByText(/Test Ale/)).toBeInTheDocument();
  expect(screen.getByText(/new brewery/)).toBeInTheDocument();
  expect(screen.getByText(/image approved \(decision 9/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Approve this manifest hash" })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Void manifest" })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Export manifest JSON" })
  ).toBeInTheDocument();
});

test("approve posts the exact manifest hash and reloads", async () => {
  mockApiGet.mockResolvedValue(detail());
  mockApiPost.mockResolvedValue(detail({ status: "approved" }));
  renderPage();
  const button = await screen.findByRole("button", {
    name: "Approve this manifest hash",
  });
  fireEvent.click(button);
  await waitFor(() =>
    expect(mockApiPost).toHaveBeenCalledWith(
      "/discovery/manifests/mf-seed-batch-20261123-01/approve",
      { sha256: SHA }
    )
  );
});

test("the approve control is hidden when can_approve is false, with the approver note shown", async () => {
  mockApiGet.mockResolvedValue(detail({ can_approve: false }));
  renderPage();
  expect(
    await screen.findByText("mf-seed-batch-20261123-01")
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve this manifest hash" })
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(/Only the manifest approver account can approve/)
  ).toBeInTheDocument();
  // Void stays available to admins in draft.
  expect(
    screen.getByRole("button", { name: "Void manifest" })
  ).toBeInTheDocument();
});

test("approved detail shows the approved hash and no approve control; imported and void hide void too", async () => {
  mockApiGet.mockResolvedValue(
    detail({
      status: "approved",
      approved_by: { id: 7, user_name: "Frank" },
      approved_at: "2026-11-23T11:00:00.000Z",
      approved_sha256: SHA,
    })
  );
  const { unmount } = renderPage();
  expect(await screen.findByText(/Approved SHA-256:/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve this manifest hash" })
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Void manifest" })
  ).toBeInTheDocument();
  unmount();

  mockApiGet.mockResolvedValue(
    detail({ status: "imported", imported_at: "2026-11-23T12:00:00.000Z" })
  );
  renderPage();
  expect(
    await screen.findByText("mf-seed-batch-20261123-01")
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Void manifest" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve this manifest hash" })
  ).not.toBeInTheDocument();
});

test("void posts to the void endpoint", async () => {
  mockApiGet.mockResolvedValue(detail({ can_approve: false }));
  mockApiPost.mockResolvedValue(detail({ status: "void" }));
  renderPage();
  const button = await screen.findByRole("button", { name: "Void manifest" });
  fireEvent.click(button);
  await waitFor(() =>
    expect(mockApiPost).toHaveBeenCalledWith(
      "/discovery/manifests/mf-seed-batch-20261123-01/void",
      {}
    )
  );
});

test("export downloads the canonical bytes through the authenticated blob endpoint", async () => {
  mockApiGet.mockResolvedValue(detail());
  mockApiGetBlobUrl.mockResolvedValue("blob:manifest");
  (URL as any).createObjectURL = jest.fn(() => "blob:manifest");
  (URL as any).revokeObjectURL = jest.fn();
  renderPage();
  const button = await screen.findByRole("button", {
    name: "Export manifest JSON",
  });
  fireEvent.click(button);
  await waitFor(() =>
    expect(mockApiGetBlobUrl).toHaveBeenCalledWith(
      "/discovery/manifests/mf-seed-batch-20261123-01/export"
    )
  );
});
