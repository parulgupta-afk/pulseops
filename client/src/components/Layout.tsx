import { NavLink, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../context/AuthContext";

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate("/login");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-pulse" />
          PulseOps
        </div>
        <nav className="nav-links">
          <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
            Incidents
          </NavLink>
          <NavLink to="/schedule" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
            On-call schedule
          </NavLink>
          <NavLink to="/escalation-policies" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
            Escalation policies
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <div>{user?.email}</div>
          <div style={{ textTransform: "capitalize" }}>{user?.role}</div>
          <button className="logout-btn" onClick={handleLogout}>Sign out</button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
