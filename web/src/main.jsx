import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./index.css";
import { SessionProvider, useSession } from "./lib/session.jsx";
import { ToastProvider, Loading } from "./components/ui.jsx";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
const Dashboard = lazy(() => import("./pages/Dashboard.jsx"));
const Orders = lazy(() => import("./pages/Orders.jsx"));
const OrderDetail = lazy(() => import("./pages/OrderDetail.jsx"));
const Inbox = lazy(() => import("./pages/Inbox.jsx"));
const Customers = lazy(() => import("./pages/Customers.jsx"));
const Marketing = lazy(() => import("./pages/Marketing.jsx"));
const CampaignDetail = lazy(() => import("./pages/CampaignDetail.jsx"));
const Templates = lazy(() => import("./pages/Templates.jsx"));
const Automations = lazy(() => import("./pages/Automations.jsx"));
const Reports = lazy(() => import("./pages/Reports.jsx"));
const Stores = lazy(() => import("./pages/Stores.jsx"));
const StoreSettings = lazy(() => import("./pages/StoreSettings.jsx"));
const Team = lazy(() => import("./pages/Team.jsx"));
const Admin = lazy(() => import("./pages/Admin.jsx"));
const Products = lazy(() => import("./pages/Products.jsx"));
const Profile = lazy(() => import("./pages/Profile.jsx"));
const Help = lazy(() => import("./pages/Help.jsx"));
const Shipments = lazy(() => import("./pages/Shipments.jsx"));
const Fraud = lazy(() => import("./pages/Fraud.jsx"));
const Profit = lazy(() => import("./pages/Profit.jsx"));
const Reviews = lazy(() => import("./pages/Reviews.jsx"));
const Flows = lazy(() => import("./pages/Flows.jsx"));
const Billing = lazy(() => import("./pages/Billing.jsx"));
const Developers = lazy(() => import("./pages/Developers.jsx"));
const Scan = lazy(() => import("./pages/Scan.jsx"));
const Finance = lazy(() => import("./pages/Finance.jsx"));
const Install = lazy(() => import("./pages/Install.jsx"));
const ClaimStore = lazy(() => import("./pages/ClaimStore.jsx"));

function Protected({ children }) {
  const { me } = useSession();
  if (me === undefined) return <Loading />;
  if (!me) return <Navigate to="/login" replace />;
  return children;
}

function App() {
  return (
    <Suspense fallback={<Loading />}>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/install" element={<Install />} />
      <Route path="/claim-store" element={<ClaimStore />} />
      <Route
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="orders" element={<Orders />} />
        <Route path="orders/:id" element={<OrderDetail />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="inbox/:id" element={<Inbox />} />
        <Route path="customers" element={<Customers />} />
        <Route path="marketing" element={<Marketing />} />
        <Route path="marketing/campaigns/:id" element={<CampaignDetail />} />
        <Route path="templates" element={<Templates />} />
        <Route path="automations" element={<Automations />} />
        <Route path="reports" element={<Reports />} />
        <Route path="stores" element={<Stores />} />
        <Route path="stores/:id" element={<StoreSettings />} />
        <Route path="team" element={<Team />} />
        <Route path="admin" element={<Admin />} />
        <Route path="products" element={<Products />} />
        <Route path="profile" element={<Profile />} />
        <Route path="help" element={<Help />} />
        <Route path="shipments" element={<Shipments />} />
        <Route path="fraud" element={<Fraud />} />
        <Route path="profit" element={<Profit />} />
        <Route path="reviews" element={<Reviews />} />
        <Route path="flows" element={<Flows />} />
        <Route path="billing" element={<Billing />} />
        <Route path="developers" element={<Developers />} />
        <Route path="scan" element={<Scan />} />
        <Route path="finance" element={<Finance />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </Suspense>
  );
}

// Warm the pages people open most, once the first screen is idle (each page is its own small file).
const warm = () => ["Orders", "Inbox", "Shipments", "OrderDetail", "Scan"].forEach((p) => import(`./pages/${p}.jsx`).catch(() => {}));
if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 4000 });
else setTimeout(warm, 2500);

// Hide broken product/media images instead of showing the browser's broken-image icon.
document.addEventListener(
  "error",
  (e) => {
    if (e.target?.tagName === "IMG") e.target.style.visibility = "hidden";
  },
  true
);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
);
