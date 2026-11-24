import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import DiscoveryBatchDecisionsPage from "./DiscoveryBatchDecisionsPage";
import { apiGet } from "../api/client";

jest.mock("../api/client", () => ({
  apiGet: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const mockApiGet = apiGet as jest.Mock;

const decisions = {
  results: [
    {
      id: 7,
      candidate_id: 9,
      pair_id: null,
      decision: "hold",
      from_status: "pending",
      to_status: "held",
      reason: "origin_uncertain",
      note: "Needs production evidence.",
      decided_by: { id: 1, user_name: "Admin One" },
      created_at: "2026-11-23T12:00:00.000Z",
    },
    {
      id: 8,
      candidate_id: 11,
      pair_id: 4,
      decision: "mark_duplicate",
      from_status: "pending",
      to_status: "same",
      reason: null,
      note: null,
      decided_by: { id: 1, user_name: "Admin One" },
      created_at: "2026-11-23T12:30:00.000Z",
    },
  ],
  pagination: { page: 1, page_size: 100, total_results: 2, total_pages: 1 },
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/admin/discovery/batches/3/decisions"]}>
      <Routes>
        <Route
          path="/admin/discovery/batches/:batchId/decisions"
          element={<DiscoveryBatchDecisionsPage />}
        />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders the batch audit with decider names, decisions, and links", async () => {
  mockApiGet.mockResolvedValue(decisions);
  renderPage();
  expect(
    await screen.findByRole("heading", { name: "Batch Decision Audit" })
  ).toBeInTheDocument();
  expect(screen.getByText("hold")).toBeInTheDocument();
  expect(screen.getByText("mark_duplicate")).toBeInTheDocument();
  expect(screen.getAllByText("Admin One")).toHaveLength(2);
  expect(screen.getByText("origin_uncertain")).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Candidate 9" })
  ).toHaveAttribute("href", "/admin/discovery/candidates/9");
  expect(screen.getByRole("link", { name: "Pair 4" })).toHaveAttribute(
    "href",
    "/admin/discovery/pairs/4"
  );
});

test("renders the empty state when no decisions exist", async () => {
  mockApiGet.mockResolvedValue({
    results: [],
    pagination: { page: 1, page_size: 100, total_results: 0, total_pages: 0 },
  });
  renderPage();
  expect(
    await screen.findByText("No decisions recorded for this batch yet.")
  ).toBeInTheDocument();
});
