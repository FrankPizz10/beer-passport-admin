// THROWAWAY QA HARNESS - not part of the app, never committed.
// Renders the real discovery pages with fixture data by patching
// window.fetch (the API client's only transport). Fixtures mirror
// the verified production facts of 2026-11-24: the 6,817-record
// domestic batch, candidate #61 Bud Light with a saved image-only
// intent (revision 1) targeting catalog beer #3784, and the
// DISCOVERY_IMAGE_STORE-unset fetch refusal. The shell framing
// (header/sidebar/breadcrumb) is static fixture markup using the
// real layout class names, because AdminLayout's Firebase auth
// guard cannot render without a signed-in admin; every page inside
// the frame is the real component with the real CSS.
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, NavLink } from "react-router-dom";
import "./index.css";
import "./App.css";
import "./viewer.css";
import DiscoveryBatchesPage from "./pages/DiscoveryBatchesPage";
import DiscoveryCandidatesPage from "./pages/DiscoveryCandidatesPage";
import DiscoveryCandidateDetailPage from "./pages/DiscoveryCandidateDetailPage";
import DiscoveryManifestsPage from "./pages/DiscoveryManifestsPage";
import DiscoveryManifestDetailPage from "./pages/DiscoveryManifestDetailPage";

const batch = {
  id: 3,
  slug: "candidates-us-full",
  title: "Full domestic set (candidates-us)",
  source: "reassessment",
  source_summary: "US domestic catalog reassessment export",
  record_count: 6817,
  status: "staged",
  bundle_sha256: "d9de3940d08b05f1afeb219ef2f54e8dd7c6ddf1c6a95549b193648cf3a39ed0",
  ingested_at: "2026-11-23T18:00:00.000Z",
  counts: {
    by_origin_bucket: { us_produced: 6607, us_market: 210 },
    by_image_status: { none: 6601, verified: 216 },
    by_hold_reason: { image_unverified: 6685, missing_brewery: 82, metadata_incomplete: 48 },
    by_review_status: { pending: 6817 },
  },
  review_progress: { total: 6817, decided: 0, pending: 6817, percent_reviewed: 0 },
};

const budLightCandidate = {
  id: 61,
  batch_id: 3,
  candidate_key: "off:018200530009",
  name: "Bud Light",
  brewery_name: "Budweiser",
  style: "Lager",
  abv: 3.2123353678124,
  ibu: null,
  description: "Light lager.",
  barcode: "018200530009",
  source: "reassessment",
  source_record_id: "018200530009",
  source_url: "https://example.org/records/bud-light",
  retrieved_at: "2026-11-23T00:00:00.000Z",
  tier: "1",
  origin_bucket: "us_produced",
  origin_evidence: [{ signal: "country", value: "United States" }],
  image_url: "https://images.example.com/bud-light.jpg",
  image_source: "open_food_facts",
  image_tier: "A",
  image_status: "staged",
  image_status_normalized: "none",
  image_verified: false,
  image_flag_reason: null,
  image_license: "CC0",
  image_page_url: null,
  image_width: null,
  image_height: null,
  hold_reason: "image_unverified",
  hold_note: null,
  review_status: "pending",
  dedupe_outcome: "no_match",
  matched_beer_id: null,
  duplicate_of_candidate_id: null,
  created_at: "2026-11-23T00:00:00.000Z",
  updated_at: "2026-11-23T00:00:00.000Z",
  batch: { id: 3, slug: "candidates-us-full", title: "Full domestic set (candidates-us)" },
  pairs: [],
  image_decision: null,
  image_decision_fetch_id: null,
  image_decision_at: null,
};

const candidateRow = (id: number, name: string, brewery: string, abv: number | null) => ({
  ...budLightCandidate,
  id,
  candidate_key: `off:row-${id}`,
  name,
  brewery_name: brewery,
  abv,
  batch: undefined,
  pairs: undefined,
});

const listOf = (results: unknown[], total = results.length) => ({
  results,
  pagination: {
    page: 1,
    page_size: 25,
    total_results: total,
    total_pages: Math.max(1, Math.ceil(total / 25)),
  },
});

const manifestSummary = {
  id: "mf-candidates-us-full-20261124-01",
  batch_id: 3,
  batch_slug: "candidates-us-full",
  record_count: 3,
  status: "draft",
  sha256: "ab".repeat(32),
  sha256_short: "ab".repeat(8),
  created_at: "2026-11-24T02:00:00.000Z",
  built_by: { id: 1, user_name: "Admin One" },
  approved_at: null,
  approved_by: null,
  approved_sha256: null,
  imported_at: null,
  can_approve: true,
};

const manifestDetail = {
  ...manifestSummary,
  catalog_fingerprint: {
    beers: { count: 5894, md5: "c".repeat(32) },
    breweries: { count: 1339, md5: "d".repeat(32) },
    beverage_images: { count: 0, md5: "e".repeat(32) },
  },
  records: [
    {
      candidate_id: 61,
      candidate_key: "off:018200530009",
      kind: "image_only",
      target_beer_id: 3784,
      beer_name: "Bud Light",
      brewery_name: "Anheuser-Busch",
      brewery: { mode: "existing", brewery_id: 99 },
      style: null,
      image: { decision_id: 5, fetch_id: 9, ref: "https://images.example.com/bud-light.jpg", sha256: "f".repeat(64) },
    },
    {
      candidate_id: 62,
      candidate_key: "off:2",
      kind: "new_beer",
      beer_name: "Harbor IPA",
      brewery_name: "Harbor Brewing",
      brewery: { mode: "new" },
      style: { mode: "new" },
      image: null,
    },
    {
      candidate_id: 63,
      candidate_key: "off:3",
      beer_name: "Prairie Lager",
      brewery_name: "Prairie Brewing",
      brewery: { mode: "existing", brewery_id: 12 },
      style: { mode: "existing", style_id: 4 },
      image: null,
    },
  ],
  events: [
    { id: 1, action: "built", from_status: null, to_status: "draft", created_at: "2026-11-24T02:00:00.000Z", actor: { id: 1, user_name: "Admin One" }, note: null },
  ],
};

const savedIntent = {
  id: 1,
  candidate_id: 61,
  intent: { mode: "image_only", target_beer_id: 3784 },
  created_at: "2026-11-24T01:00:00.000Z",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input.toString());
  const path = url.pathname.replace(/^\/admin-api\/v1/, "");
  const method = (init?.method ?? "GET").toUpperCase();
  if (path === "/discovery/batches") return json({ results: [batch] });
  if (path === "/discovery/batches/3/candidates") {
    return json(
      listOf(
        [
          candidateRow(61, "Bud Light", "Budweiser", 3.2123353678124),
          candidateRow(62, "Harbor IPA", "Harbor Brewing", 6.4),
          candidateRow(63, "Prairie Lager", "Prairie Brewing", 4.8),
          candidateRow(64, "Copper Amber Ale", "Copper Brewing", 5.2),
        ],
        6817
      )
    );
  }
  if (path === "/discovery/candidates/61") return json(budLightCandidate);
  if (path === "/discovery/candidates/61/decisions") return json(listOf([]));
  if (path === "/discovery/candidates/61/review-intent") return json(savedIntent);
  if (path === "/discovery/candidates/61/image-fetches") {
    if (method === "POST") {
      return json(
        { error: { message: "DISCOVERY_IMAGE_STORE is unset: the server cannot store fetched images." } },
        503
      );
    }
    return json(listOf([]));
  }
  if (path === "/discovery/candidates/61/image-decisions") return json(listOf([]));
  if (path === "/catalog/beers/3784") {
    return json({ id: 3784, name: "Bud Light", brewery: { id: 99, name: "Anheuser-Busch" } });
  }
  if (path === "/catalog/beers") {
    return json(
      listOf([
        { id: 3784, name: "Bud Light", brewery: { id: 99, name: "Anheuser-Busch" } },
        { id: 5123, name: "Bud Light Lime", brewery: { id: 99, name: "Anheuser-Busch" } },
      ])
    );
  }
  if (path === "/discovery/manifests") return json(listOf([manifestSummary]));
  if (path === `/discovery/manifests/${manifestSummary.id}`) return json(manifestDetail);
  return json({ error: { message: `harness: no fixture for ${method} ${path}` } }, 404);
};

window.fetch = fixtureFetch as typeof window.fetch;

// For the store-unset screenshot: click the real fetch button once
// the panel has rendered, so the 503 state appears.
const AutoFetch: React.FC = () => {
  useEffect(() => {
    const timer = setInterval(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const fetchButton = buttons.find(
        (b) => b.textContent === "Fetch image for review"
      );
      if (fetchButton) {
        (fetchButton as HTMLButtonElement).click();
        clearInterval(timer);
      }
    }, 300);
    return () => clearInterval(timer);
  }, []);
  return null;
};

const Shell: React.FC<{ crumb: string; autoFetch?: boolean }> = ({ crumb, autoFetch }) => (
  <div className="admin-shell">
    <header className="admin-header">
      <button type="button" className="nav-toggle" aria-expanded="false" aria-label="Toggle navigation menu">
        &#9776;
      </button>
      <div className="header-title">
        <span className="brand-badge" aria-hidden="true">BP</span> BeerPassport{" "}
        <span className="brand-mark">Admin</span>
      </div>
      <div className="header-meta">
        <span className="chip" title="Database target">db.example / beerpassport</span>
        <span className="signed-in-email">admin@example.com</span>
        <button type="button">Logout</button>
      </div>
    </header>
    <div className="admin-body">
      <nav className="admin-sidebar" aria-label="Admin">
        <div className="nav-section">Catalog</div>
        <NavLink to="/admin/catalog/overview">Overview</NavLink>
        <NavLink to="/admin/catalog/beers">Beers</NavLink>
        <NavLink to="/admin/catalog/breweries">Breweries</NavLink>
        <NavLink to="/admin/catalog/categories">Categories</NavLink>
        <NavLink to="/admin/catalog/styles">Styles</NavLink>
        <NavLink to="/admin/catalog/collections">Collections</NavLink>
        <NavLink to="/admin/catalog/beverage-images">Beverage Images</NavLink>
        <NavLink to="/admin/catalog/image-queue">Image Queue</NavLink>
        <div className="nav-section">Discovery</div>
        <NavLink to="/admin/discovery/batches">Batches</NavLink>
        <NavLink to="/admin/discovery/manifests">Manifests</NavLink>
        <div className="nav-section">User Data</div>
        <NavLink to="/admin/users">Users</NavLink>
        <div className="nav-section">Admin Accounts</div>
        <NavLink to="/admin/admin/accounts">Accounts</NavLink>
        <NavLink to="/admin/admin/api-keys">API Keys</NavLink>
      </nav>
      <main className="admin-main">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <span aria-current="page">{crumb}</span>
        </nav>
        <Routes>
          <Route path="/admin/discovery/batches" element={<DiscoveryBatchesPage />} />
          <Route path="/admin/discovery/batches/:batchId/candidates" element={<DiscoveryCandidatesPage />} />
          <Route path="/admin/discovery/candidates/:id" element={<DiscoveryCandidateDetailPage />} />
          <Route path="/admin/discovery/manifests" element={<DiscoveryManifestsPage />} />
          <Route path="/admin/discovery/manifests/:id" element={<DiscoveryManifestDetailPage />} />
        </Routes>
        {autoFetch ? <AutoFetch /> : null}
      </main>
    </div>
  </div>
);

const view = window.location.hash.replace(/^#/, "") || "/batches";
const routes: Record<string, { entry: string; crumb: string; autoFetch?: boolean }> = {
  "/batches": { entry: "/admin/discovery/batches", crumb: "Discovery / Batches" },
  "/candidates": { entry: "/admin/discovery/batches/3/candidates", crumb: "Discovery / Batches / Candidates" },
  "/candidate": { entry: "/admin/discovery/candidates/61", crumb: "Discovery / Candidates / Detail" },
  "/candidate-store": { entry: "/admin/discovery/candidates/61", crumb: "Discovery / Candidates / Detail", autoFetch: true },
  "/manifests": { entry: "/admin/discovery/manifests", crumb: "Discovery / Manifests" },
  "/manifest": { entry: `/admin/discovery/manifests/${manifestSummary.id}`, crumb: "Discovery / Manifests / Detail" },
};
const chosen = routes[view] ?? routes["/batches"];

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <MemoryRouter initialEntries={[chosen.entry]}>
    <Shell crumb={chosen.crumb} autoFetch={chosen.autoFetch} />
  </MemoryRouter>
);
