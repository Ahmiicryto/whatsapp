import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./index.css";
import { SessionProvider, useSession } from "./lib/session.jsx";
import { ToastProvider, Loading } from "./components/ui.jsx";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Orders from "./pages/Orders.jsx";
import OrderDetail from "./pages/OrderDetail.jsx";
import Inbox from "./pages/Inbox.jsx";
import Customers from "./pages/Customers.jsx";
import Marketing from "./pages/Marketing.jsx";
import CampaignDetail from "./pages/CampaignDetail.jsx";
import Templates from "./pages/Templates.jsx";
import Automations from "./pages/Automations.jsx";
import Reports from "./pages/Reports.jsx";
import Stores from "./pages/Stores.jsx";
import StoreSettings from "./pages/StoreSettings.jsx";
import Team from "./pages/Team.jsx";
import Admin from "./pages/Admin.jsx";
import Install from "./pages/Install.jsx";
import ClaimStore from "./pages/ClaimStore.jsx";

function Protected({ children }) {
  const { me } = useSession();
  if (me === undefined) return <Loading />;
  if (!me) return <Navigate to="/login" replace />;
  return children;
}

function App() {
  return (
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

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
