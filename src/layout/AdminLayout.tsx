import React, { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../Firebase/firebase";
import { apiGet } from "../api/client";
import { TargetInfo } from "../api/types";
import ErrorBoundary from "../components/ErrorBoundary";

// Client side guarding is UX only. The server rechecks the admin claim on
// every API request, so this layout is not a security boundary.
const AdminLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [checked, setChecked] = useState(false);
  const [email, setEmail] = useState<string>("");
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  // Close the mobile nav whenever the route changes.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        navigate("/");
        return;
      }
      user
        .getIdTokenResult()
        .then((result) => {
          if (!result.claims.admin) {
            navigate("/");
            return;
          }
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
        <div className="header-title">BeerPassport Admin Viewer</div>
        <div className="header-meta">
          {target && (
            <span className="chip" title="Database target">
              {target.host} / {target.database}
            </span>
          )}
          {email && <span className="signed-in-email">{email}</span>}
          <button type="button" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>
      <div className="admin-body">
        <nav
          id="admin-primary-nav"
          className={navOpen ? "admin-sidebar open" : "admin-sidebar"}
          aria-label="Admin"
        >
          <div className="nav-section">Catalog</div>
          <NavLink to="catalog/overview">Overview</NavLink>
          <NavLink to="catalog/beers">Beers</NavLink>
          <NavLink to="catalog/breweries">Breweries</NavLink>
          <NavLink to="catalog/categories">Categories</NavLink>
          <NavLink to="catalog/styles">Styles</NavLink>
          <NavLink to="catalog/collections">Collections</NavLink>
          <NavLink to="catalog/beverage-images">Beverage Images</NavLink>
          <NavLink to="catalog/image-queue">Image Queue</NavLink>
          <div className="nav-section">Discovery</div>
          <NavLink to="discovery/batches">Batches</NavLink>
          <div className="nav-section">User Data</div>
          <NavLink to="users">Users</NavLink>
          <div className="nav-section">Admin Accounts</div>
          <NavLink to="admin/accounts">Accounts</NavLink>
          <NavLink to="admin/api-keys">API Keys</NavLink>
        </nav>
        <main className="admin-main">
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
};

export default AdminLayout;
