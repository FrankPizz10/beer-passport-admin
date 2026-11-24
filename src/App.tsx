import "./App.css";
import "./viewer.css";
import SignInPage from "./MainScreen/SignInPage";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import ErrorBoundary from "./components/ErrorBoundary";
import AdminLayout from "./layout/AdminLayout";
import CatalogOverviewPage from "./pages/CatalogOverviewPage";
import BeersPage from "./pages/BeersPage";
import BeerDetailPage from "./pages/BeerDetailPage";
import BreweriesPage from "./pages/BreweriesPage";
import BreweryDetailPage from "./pages/BreweryDetailPage";
import CategoriesPage from "./pages/CategoriesPage";
import CategoryDetailPage from "./pages/CategoryDetailPage";
import StylesPage from "./pages/StylesPage";
import StyleDetailPage from "./pages/StyleDetailPage";
import CollectionsPage from "./pages/CollectionsPage";
import CollectionDetailPage from "./pages/CollectionDetailPage";
import BeverageImagesPage from "./pages/BeverageImagesPage";
import ImageQueuePage from "./pages/ImageQueuePage";
import UsersPage from "./pages/UsersPage";
import UserDetailPage from "./pages/UserDetailPage";
import AdminAccountsPage from "./pages/AdminAccountsPage";
import ApiKeysPage from "./pages/ApiKeysPage";
import DiscoveryBatchesPage from "./pages/DiscoveryBatchesPage";
import DiscoveryCandidatesPage from "./pages/DiscoveryCandidatesPage";
import DiscoveryCandidateDetailPage from "./pages/DiscoveryCandidateDetailPage";
import DiscoveryPairPage from "./pages/DiscoveryPairPage";
import DiscoveryBatchDecisionsPage from "./pages/DiscoveryBatchDecisionsPage";

function AppRoutes() {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location.pathname}>
      <Routes>
        <Route path="/" element={<SignInPage />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="catalog/beers" replace />} />
          <Route path="catalog/overview" element={<CatalogOverviewPage />} />
          <Route path="catalog/beers" element={<BeersPage />} />
          <Route path="catalog/beers/:id" element={<BeerDetailPage />} />
          <Route path="catalog/breweries" element={<BreweriesPage />} />
          <Route path="catalog/breweries/:id" element={<BreweryDetailPage />} />
          <Route path="catalog/categories" element={<CategoriesPage />} />
          <Route path="catalog/categories/:id" element={<CategoryDetailPage />} />
          <Route path="catalog/styles" element={<StylesPage />} />
          <Route path="catalog/styles/:id" element={<StyleDetailPage />} />
          <Route path="catalog/collections" element={<CollectionsPage />} />
          <Route path="catalog/collections/:id" element={<CollectionDetailPage />} />
          <Route path="catalog/beverage-images" element={<BeverageImagesPage />} />
          <Route path="catalog/image-queue" element={<ImageQueuePage />} />
          <Route path="discovery/batches" element={<DiscoveryBatchesPage />} />
          <Route path="discovery/batches/:batchId/candidates" element={<DiscoveryCandidatesPage />} />
          <Route path="discovery/batches/:batchId/decisions" element={<DiscoveryBatchDecisionsPage />} />
          <Route path="discovery/candidates/:id" element={<DiscoveryCandidateDetailPage />} />
          <Route path="discovery/pairs/:pairId" element={<DiscoveryPairPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="users/:id" element={<UserDetailPage />} />
          <Route path="admin/accounts" element={<AdminAccountsPage />} />
          <Route path="admin/api-keys" element={<ApiKeysPage />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

export default App;
