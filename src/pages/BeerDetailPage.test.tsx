import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import BeerDetailPage from "./BeerDetailPage";
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

// A beverage whose approved image lives in private storage: the detail
// payload reports kind "product" with image_url null.
const privateBeerDetail = {
  id: 7,
  name: "Secret Stout",
  abv: 6.4,
  ibu: 35,
  srm: 30,
  upc: null,
  descript: "A stout.",
  discontinued: false,
  last_mod: "2026-01-01T00:00:00.000Z",
  brewery: { id: 1, name: "Brewery One" },
  style: { id: 2, name: "Stout" },
  category: { id: 3, name: "Ale" },
  image_url: null,
  image_kind: "product",
  image_provenance: {
    tier: "A",
    source_type: "test",
    license_type: "CC0",
    attribution: "",
    license_url: "",
    status: "approved",
  },
  collections: [],
  user_beers_count: 3,
  liked_count: 1,
  counts: { user_beers: 3, liked_user_beers: 1 },
};

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={["/admin/catalog/beers/7"]}>
      <Routes>
        <Route path="/admin/catalog/beers/:id" element={<BeerDetailPage />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders the presigned image when the images endpoint returns a URL", async () => {
  mockApiGet.mockImplementation((path: string) => {
    if (path === "/catalog/beers/7") return Promise.resolve(privateBeerDetail);
    if (path === "/images/7")
      return Promise.resolve({
        url: "https://signed.example.com/presigned-object",
        expires_at: "2026-01-01T00:15:00.000Z",
      });
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
  renderDetail();
  const img = await screen.findByAltText("Secret Stout");
  expect(img).toHaveAttribute(
    "src",
    "https://signed.example.com/presigned-object"
  );
  expect(mockApiGet).toHaveBeenCalledWith("/images/7");
});

test("falls back to initials when the images endpoint fails", async () => {
  mockApiGet.mockImplementation((path: string) => {
    if (path === "/catalog/beers/7") return Promise.resolve(privateBeerDetail);
    return Promise.reject(new Error("no signed url"));
  });
  renderDetail();
  expect(
    await screen.findByText("No approved image exists for this beer.")
  ).toBeInTheDocument();
  expect(screen.getByText("SS")).toBeInTheDocument();
  expect(screen.queryByAltText("Secret Stout")).not.toBeInTheDocument();
});
