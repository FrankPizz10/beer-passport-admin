# Proposed PR (reliability / mobile)

**Title:** Admin reliability and mobile: fix response-shape crashes, add error boundary, SPA fallback, iPhone layout

**Branch:** `reliability/response-shapes-mobile` (local only, not pushed), based on master `2d06689`.

## PR description (proposed)

### Root causes fixed (all client-side; no server response shape changed)

The list endpoints return an envelope `{ results, pagination }`, but the
detail endpoints return a FLAT body: entity fields, sub-lists as plain
arrays, and pagination at the top level. Several detail pages were
written against the envelope and crashed or silently rendered nothing:

- **Catalog Overview (blank page):** `GET /admin/overview` sends
  `{ counts, ...counts }`. The page iterated the whole body and tried
  to render the nested `counts` object as a React child, throwing and
  unmounting the app. Now consumes `data.counts` via a new
  `OverviewResponse` type.
- **Brewery detail (blank page):** the API sends `beers` as a plain
  array with `pagination` at the top level; the page read
  `data.beers.results` (always empty) and `data.beers.pagination.page`
  (throws on an array). Now rows come from the array and pagination
  from the top level. Geocode block verified against
  `breweryGeocodeSelect` (latitude/longitude/accuracy) with a null and
  a present-geocode test.
- **Collection detail (blank page):** same pattern via
  `data.beers || data.collection_beers` treated as an envelope. Now
  maps the flat member-row array (`{ id, beer, collection,
  created_at }`) and reads top-level pagination.
- **Category detail (permanently empty Beers table):** the detail
  endpoint returns NO beers and NO pagination at all. The page now
  loads category beers from `GET /catalog/beers?category_id=:id`
  (the standard list envelope) with its own pagination and error
  state.
- **Style detail (permanently empty Beers table):** same fix via
  `GET /catalog/beers?style_id=:id`.
- **Beer detail:** the API sends `user_beers_count`; the page read
  `user_beer_count`, so "Users who tried it" was always blank. Fixed
  in the page, the `BeerDetail` type, and the existing test fixture
  (which had baked in the wrong field name).
- **Users list and user detail:** the API sends `tried_count`; the
  client used `beer_count`, so "Beers Tried" / "Beers tried" were
  always blank. Fixed in `AppUser`/`UserDetail` types and both pages.
  The friends tab also now guards a null `other_user` (the API can
  return one).
- **Breweries list:** the "Beers" column was sortable with key
  `beer_count`, which is not in the server sort allowlist
  (`name, city, last_mod, id`), so clicking it produced a 400. The
  column is no longer sortable.
- **Beverage Images list:** dropped the never-sent `beer` ref from
  the `BeverageImage` type and the dead fallback in the row render
  (the API returns no beer relation on this endpoint).
- **Types:** `src/api/types.ts` now matches the real shapes for every
  route (overview, target with nullable fields, all lists, all
  details). Every page was audited against its server handler and
  the projections/serializers; the remaining pages (beers, breweries,
  categories, styles, collections, users tabs, API keys, accounts)
  already matched the envelope shapes.

### Error boundary

New `src/components/ErrorBoundary.tsx`: catches render errors, logs
to console, and shows a recoverable card (error message, a Reload
button that clears the error and remounts children, and a link back
to the overview). It is mounted around the `<Outlet/>` in
`AdminLayout` (so a page crash keeps the navigation shell alive) and
around the whole route tree in `App.tsx`, and it resets when the
route pathname changes, so navigating away recovers without a full
page reload.

### Netlify SPA fallback

`public/_redirects` added with exactly `/* /index.html 200`. CRA
copies it into `build/` (verified in the production build output), so
direct links and refreshes on client routes such as
`/admin/catalog/beers` reach the app instead of Netlify's Page not
found. No `netlify.toml` exists in the repo and none was needed.

### Mobile (iPhone) pass

All changes are component-level (AdminLayout, DataTable, Pagination,
counts-grid, detail-grid) in `src/viewer.css` /
`src/MainScreen/SignInForm.css`, so pages built on these components —
including the Image Queue page on the `image/approval-workflow`
branch — inherit them when that branch lands:

- At <= 820px the sidebar becomes a top bar: a hamburger button
  (44px, `aria-expanded` / `aria-controls`) toggles the nav; nav
  links are full-width rows; the nav closes on route change.
- At <= 700px the counts grid and detail grids collapse to one
  column, and DataTable rows render as stacked cards with visible
  per-cell labels (the component now emits `data-label` from the
  column label; the header row is visually hidden). No horizontal
  page overflow at 390px on any checked page.
- On coarse pointers, buttons, pagination controls, tabs, nav links,
  sort buttons, and filter controls are at least 44px tall; filter
  and sign-in inputs use 16px text to prevent iOS focus zoom.
- Visible `:focus-visible` outlines across the shell and sign-in
  form. Filter/search controls on every list page and the sign-in
  form now have explicit `<label htmlFor>` + `id` association (the
  pagination page-size select too).

### Test report

Client (jest, `CI=true npx react-scripts test --watchAll=false`):
**11 suites passed, 19 tests passed, 0 failed.** New regression
tests use fixtures copied from the actual server serializers:

- `CatalogOverviewPage.test.tsx`: the real `{ counts, ...counts }`
  body renders one card per table.
- `BreweryDetailPage.test.tsx`: the real flat shape renders beer
  rows and pagination; second case renders the geocode block.
- `CollectionDetailPage.test.tsx`: the real flat member-row shape
  renders rows and pagination.
- `CategoryDetailPage.test.tsx` / `StyleDetailPage.test.tsx`: detail
  body without beers + the filtered list envelope render styles /
  category link, beer rows, and pagination.
- `ErrorBoundary.test.tsx`: a throwing child renders the fallback;
  Reload remounts the child once it stops throwing; a resetKey
  change also clears the error.
- `redirects.test.ts`: `public/_redirects` contains exactly the SPA
  fallback rule.

Production build (`npm run build`): succeeds; `build/_redirects`
present with the fallback rule.

Server (`cd server && npx jest`, with the sandbox Prisma engine env
vars): **7 suites passed, 1 skipped (live-DB suite), 38 tests
passed, 4 skipped, 0 failed** — the server is untouched by this PR
and stays green.

### Viewport QA (Playwright, own Chromium, dev server on localhost)

The dev server ran with route interception: `/admin-api/v1/**` was
fulfilled with the real response shapes and the Firebase Auth REST
endpoints with a fabricated admin ID token, so the genuine sign-in
flow, layout guard, and pages ran end to end. Screenshots are in
`qa-screenshots-reliability/` (not committed): sign-in, overview,
nav drawer (iPhone only), beers list, brewery detail, and collection
detail at both viewports.

- iPhone 390x844: sign-in renders; sign-in flow lands on the beers
  list; overview count cards stack in one column; the hamburger
  toggles a full-width nav drawer; the beers table renders as
  labeled cards; brewery detail (with geocode) and collection
  detail render fully; `documentElement.scrollWidth == innerWidth`
  (390) on every page — no horizontal overflow, no blank pages;
  direct link + refresh on `/admin/catalog/beers` works.
- Desktop 1280x800: same pages render with the classic sidebar and
  table layouts; the nav toggle is hidden; no overflow
  (scrollWidth == 1280).

### Notes

- No new dependencies; `package.json` and both lockfiles unchanged.
- No server files changed.
- The `image/approval-workflow` branch is untouched by this work.
