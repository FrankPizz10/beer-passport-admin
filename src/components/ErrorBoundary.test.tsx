import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ErrorBoundary from "./ErrorBoundary";

let shouldThrow = true;

const Bomb: React.FC = () => {
  if (shouldThrow) {
    throw new Error("kaboom");
  }
  return <div>Recovered content</div>;
};

beforeEach(() => {
  shouldThrow = true;
  // The boundary logs caught errors; keep test output readable.
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore();
});

test("renders the fallback card when a child throws", () => {
  render(
    <MemoryRouter>
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    </MemoryRouter>
  );
  expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  expect(screen.getByText(/kaboom/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to overview" })).toHaveAttribute(
    "href",
    "/admin/catalog/overview"
  );
});

test("Reload clears the error and remounts the children", () => {
  render(
    <MemoryRouter>
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    </MemoryRouter>
  );
  expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  shouldThrow = false;
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(screen.getByText("Recovered content")).toBeInTheDocument();
  expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
});

test("a resetKey change clears a caught error", () => {
  const { rerender } = render(
    <MemoryRouter>
      <ErrorBoundary resetKey="/admin/catalog/beers">
        <Bomb />
      </ErrorBoundary>
    </MemoryRouter>
  );
  expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  shouldThrow = false;
  rerender(
    <MemoryRouter>
      <ErrorBoundary resetKey="/admin/catalog/breweries">
        <Bomb />
      </ErrorBoundary>
    </MemoryRouter>
  );
  expect(screen.getByText("Recovered content")).toBeInTheDocument();
});
