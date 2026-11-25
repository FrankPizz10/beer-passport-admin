import { DiscoveryCandidate } from "../../api/types";
import { imageIndicator } from "./queueFilters";

// The list serializer always emits image_status_normalized, but the
// column is nullable (null = the server's not_staged value) and new
// server values must never be presented as a known state.
const row = (image_status_normalized: string | null) =>
  ({ image_status_normalized }) as DiscoveryCandidate;

test("imageIndicator maps the known statuses", () => {
  expect(imageIndicator(row("verified"))).toBe("Image: verified");
  expect(imageIndicator(row("gate_passed_unverified"))).toBe(
    "Image: gate passed"
  );
  expect(imageIndicator(row("failed"))).toBe("Image: staging check failed");
  expect(imageIndicator(row("none"))).toBe("No image");
});

test("imageIndicator treats null as the server's not-staged value", () => {
  expect(imageIndicator(row(null))).toBe("Image: not staged");
});

test("imageIndicator reports unrecognized or absent values as unknown", () => {
  expect(imageIndicator(row("some_future_status"))).toBe("Image: unknown");
  expect(
    imageIndicator({} as DiscoveryCandidate)
  ).toBe("Image: unknown");
});
