import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import type { AuthUser } from "@pulseops/shared-types";

interface AuthContextValue {
  user: AuthUser | null;
  login: (token: string, user: AuthUser) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("pulseops_user");
    if (stored) setUser(JSON.parse(stored));
  }, []);

  function login(token: string, user: AuthUser) {
    localStorage.setItem("pulseops_token", token);
    localStorage.setItem("pulseops_user", JSON.stringify(user));
    setUser(user);
  }

  function logout() {
    localStorage.removeItem("pulseops_token");
    localStorage.removeItem("pulseops_user");
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
