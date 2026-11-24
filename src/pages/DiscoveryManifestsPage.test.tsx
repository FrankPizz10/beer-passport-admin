import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DiscoveryManifestsPage from "./DiscoveryManifestsPage";
import { apiGet } from "../api/client";

jest.mock("../api/client", () => ({
  apiGet: jest.fn(),
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

const draft = {
  id: "mf-seed-batch-20261123-01",
  batch_id: 3,
  batch_slug: "seed-batch",
  record_count: 12,
  status: "draft",
  sha256: "a".repeat(64),
  sha256_short: "a".repeat(12),
  built_by: { id: 1, user_name: "Admin One" },
  approved_by: null,
  approved_at: null,
  approved_sha256: null,
  imported_at: null,
  created_at: "2026-11-23T10:00:00.000Z",
  can_approve: false,
};

const imported = {
  ...draft,
  id: "mf-seed-batch-20261120-01",
  status: "imported",
  sha256: "b".repeat(64),
  sha256_short: "b".repeat(12),
  approved_by: { id: 7, user_name: "Frank" },
  approved_at: "2026-11-20T12:00:00.000Z",
  approved_sha256: "a".repeat(64),
  imported_at: "2026-11-20T13:00:00.000Z",
};

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders manifests with status, short hash, and approval state", async () => {
  mockApiGet.mockResolvedValue({
    results: [draft, imported],
    pagination: { page: 1, page_size: 25, total_results: 2, total_pages: 1 },
  });
  render(
    <MemoryRouter>
      <DiscoveryManifestsPage />
    </MemoryRouter>
  );
  expect(
    await screen.findByText("mf-seed-batch-20261123-01")
  ).toBeInTheDocument();
  expect(screen.getByText("draft")).toBeInTheDocument();
  expect(screen.getByText("imported")).toBeInTheDocument();
  expect(screen.getByText(`${"a".repeat(12)}…`)).toBeInTheDocument();
  expect(screen.getByText("Not approved")).toBeInTheDocument();
  expect(screen.getByText(/Approved .* by Frank/)).toBeInTheDocument();
  const link = screen.getByRole("link", {
    name: "mf-seed-batch-20261123-01",
  });
  expect(link).toHaveAttribute(
    "href",
    "/admin/discovery/manifests/mf-seed-batch-20261123-01"
  );
});

test("renders the empty state when there are no manifests", async () => {
  mockApiGet.mockResolvedValue({
    results: [],
    pagination: { page: 1, page_size: 25, total_results: 0, total_pages: 0 },
  });
  render(
    <MemoryRouter>
      <DiscoveryManifestsPage />
    </MemoryRouter>
  );
  expect(
    await screen.findByText(/No discovery import manifests found/i)
  ).toBeInTheDocument();
});

test("renders the error state when apiGet rejects", async () => {
  mockApiGet.mockRejectedValue(new Error("Server exploded"));
  render(
    <MemoryRouter>
      <DiscoveryManifestsPage />
    </MemoryRouter>
  );
  expect(await screen.findByText("Server exploded")).toBeInTheDocument();
});
