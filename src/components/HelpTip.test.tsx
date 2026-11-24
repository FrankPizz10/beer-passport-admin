import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import HelpTip from "./HelpTip";

const renderTip = () =>
  render(
    <p>
      Review intent
      <HelpTip topic="review intent">
        An intent records what should be imported for a candidate.
      </HelpTip>
    </p>
  );

test("the button has an accessible name and the popover starts closed", () => {
  renderTip();
  const button = screen.getByRole("button", { name: "Help: review intent" });
  expect(button).toHaveTextContent("?");
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByText(/records what should be imported/)
  ).not.toBeInTheDocument();
});

test("click opens the popover and a second click closes it", () => {
  renderTip();
  const button = screen.getByRole("button", { name: "Help: review intent" });
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded", "true");
  expect(
    screen.getByText(/records what should be imported/)
  ).toBeInTheDocument();
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByText(/records what should be imported/)
  ).not.toBeInTheDocument();
});

test("keyboard focus opens the popover", () => {
  renderTip();
  const button = screen.getByRole("button", { name: "Help: review intent" });
  fireEvent.focus(button);
  expect(
    screen.getByText(/records what should be imported/)
  ).toBeInTheDocument();
});

test("hover opens the popover", () => {
  const { container } = renderTip();
  const wrapper = container.querySelector(".help-tip") as HTMLElement;
  fireEvent.mouseEnter(wrapper);
  expect(
    screen.getByText(/records what should be imported/)
  ).toBeInTheDocument();
});

test("Escape closes the popover and returns focus to the button", () => {
  renderTip();
  const button = screen.getByRole("button", { name: "Help: review intent" });
  fireEvent.click(button);
  expect(
    screen.getByText(/records what should be imported/)
  ).toBeInTheDocument();
  fireEvent.keyDown(button, { key: "Escape" });
  expect(
    screen.queryByText(/records what should be imported/)
  ).not.toBeInTheDocument();
  expect(button).toHaveFocus();
});
