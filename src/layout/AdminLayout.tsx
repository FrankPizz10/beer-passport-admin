import React, { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../Firebase/firebase";
import { apiGet } from "../api/client";
import { TargetInfo } from "../api/types";
import ErrorBoundary from "../components/ErrorBoundary";

// Breadcrumb labels for the route segments under /admin. Detail
// routes (an id segment) collapse to a generic final crumb so raw
// ids never become the page's only context.
const CRUMB_LABELS: Record<string, string> = {
  catalog: "Catalog",
  overview: "Overview",
  beers: "Beers",
  breweries: "Breweries",
  categories: "Categories",
  styles: "Styles",
  collections: "Collections",
  "beverage-images": "Beverage Images",
  changes: "Catalog Changes",
  "image-queue": "Catalog Image Approvals",
  discovery: "Discovery",
  "review-queue": "Review Queue",
  batches: "Batches",
  manifests: "Manifests",
  candidates: "Candidates",
  decisions: "Decision Audit",
  pairs: "Duplicate Pair",
  users: "Users",
  admin: "Admin Accounts",
  accounts: "Accounts",
};

const buildCrumbs = (pathname: string): { label: string; to?: string }[] => {
  const segments = pathname
    .replace(/^\/admin\/?/, "")
    .split("/")
    .filter(Boolean);
  const crumbs: { label: string; to?: string }[] = [];
  let path = "/admin";
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    const numeric = /^\d+$/.test(segment);
    const longId = segment.length > 24; // manifest ids and similar
    if (numeric || longId) {
      crumbs.push({ label: "Detail" });
      return;
    }
    path += `/${segment}`;
    crumbs.push({
      label: CRUMB_LABELS[segment] ?? segment,
      to: isLast ? undefined : path,
    });
  });
  return crumbs;
};

// Client-side guarding is UX only. The API checks the current access grant
// on every request; this layout is not a security boundary.
const AdminLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [checked, setChecked] = useState(false);
  const [role, setRole] = useState<"owner" | "admin" | null>(null);
  const [email, setEmail] = useState<string>("");
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountMenuRef = React.useRef<HTMLDivElement>(null);

  // Close the mobile nav whenever the route changes.
  useEffect(() => {
    setNavOpen(false);
    setAccountOpen(false);
  }, [location.pathname]);

  // Close the account menu on an outside pointer press or Escape,
  // so the compact header never leaves a stale menu over content.
  useEffect(() => {
    if (!accountOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        accountMenuRef.current &&
        !accountMenuRef.current.contains(event.target as Node)
      ) {
        setAccountOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [accountOpen]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        navigate("/");
        return;
      }
      apiGet<{ role: "owner" | "admin" }>("/admin/session")
        .then((result) => {
          if (result.role !== "owner" && result.role !== "admin") {
            navigate("/");
            return;
          }
          setRole(result.role);
          const stateEmail = (location.state as any)?.user;
          setEmail(stateEmail || user.email || auth.currentUser?.email || "");
          setChecked(true);
        })
        .catch(() => navigate("/"));
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  useEffect(() => {
    if (!checked) return;
    let cancelled = false;
    apiGet<TargetInfo>("/admin/target")
      .then((t) => {
        if (!cancelled) setTarget(t);
      })
      .catch(() => {
        if (!cancelled) setTarget(null);
      });
    return () => {
      cancelled = true;
    };
  }, [checked]);

  const handleLogout = async () => {
    await auth.signOut();
    navigate("/");
  };

  if (!checked) {
    return <div className="state-box">Loading...</div>;
  }

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={navOpen}
          aria-controls="admin-primary-nav"
          aria-label="Toggle navigation menu"
          onClick={() => setNavOpen((open) => !open)}
        >
          &#9776;
        </button>
        <div className="header-title">
          <span className="brand-badge" aria-hidden="true">BP</span>{" "}
          BeerPassport <span className="brand-mark">Admin</span>
        </div>
        <div className="header-meta">
          {target && (
            <span className="chip header-target-chip" title="Database target">
              {target.host} / {target.database}
            </span>
          )}
          <div className="account-menu-wrap" ref={accountMenuRef}>
            <button
              type="button"
              className="account-menu-button"
              aria-haspopup="true"
              aria-expanded={accountOpen}
              aria-label="Account menu"
              onClick={() => setAccountOpen((open) => !open)}
            >
              Account
            </button>
            {accountOpen && (
              <div className="account-menu" role="menu">
                {email && (
                  <div className="account-menu-email">
                    Signed in as
                    <br />
                    <span className="signed-in-email">{email}</span>
                  </div>
                )}
                {target && (
                  <div className="account-menu-target">
                    Database: {target.host} / {target.database}
                  </div>
                )}
                <button type="button" role="menuitem" onClick={handleLogout}>
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="admin-body">
        <nav
          id="admin-primary-nav"
          className={navOpen ? "admin-sidebar open" : "admin-sidebar"}
          aria-label="Admin"
        >
          <div className="nav-section">Catalog</div>
          {role === "owner" && <NavLink to="catalog/overview">Overview</NavLink>}
          <NavLink to="catalog/beers">Beers</NavLink>
          <NavLink to="catalog/breweries">Breweries</NavLink>
          <NavLink to="catalog/categories">Categories</NavLink>
          <NavLink to="catalog/styles">Styles</NavLink>
          <NavLink to="catalog/collections">Collections</NavLink>
          <NavLink to="catalog/beverage-images">Beverage Images</NavLink>
          <NavLink to="catalog/changes">Catalog Changes</NavLink>
          <div className="nav-section">Discovery</div>
          <NavLink to="discovery/review-queue">Review Queue</NavLink>
          <NavLink to="discovery/batches">Batches</NavLink>
          <NavLink to="discovery/manifests">Manifests</NavLink>
          <div className="nav-section">User Data</div>
          <NavLink to="users">Users</NavLink>
          {role === "owner" && <><div className="nav-section">Admin Accounts</div><NavLink to="admin/accounts">Accounts</NavLink></>}
        </nav>
        <main className="admin-main">
          {(() => {
            const crumbs = buildCrumbs(location.pathname);
            if (crumbs.length === 0) return null;
            return (
              <nav className="breadcrumb" aria-label="Breadcrumb">
                {crumbs.map((crumb, index) => (
                  <React.Fragment key={`${crumb.label}-${index}`}>
                    {index > 0 && (
                      <span className="crumb-sep" aria-hidden="true">
                        /
                      </span>
                    )}
                    {crumb.to ? (
                      <NavLink to={crumb.to}>{crumb.label}</NavLink>
                    ) : (
                      <span aria-current="page">{crumb.label}</span>
                    )}
                  </React.Fragment>
                ))}
              </nav>
            );
          })()}
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
};

export default AdminLayout;
