import * as fs from "fs";
import * as path from "path";

// Netlify serves the SPA only when public/_redirects carries the
// fallback rule; CRA copies public/ into build/ verbatim. Without it,
// direct links and refreshes on client routes (e.g.
// /admin/catalog/beers) return Netlify's Page not found.
test("public/_redirects contains the SPA fallback rule", () => {
  const file = path.resolve(__dirname, "..", "public", "_redirects");
  const content = fs.readFileSync(file, "utf8");
  expect(content.trim()).toBe("/* /index.html 200");
});
