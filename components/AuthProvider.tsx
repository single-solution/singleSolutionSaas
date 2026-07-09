"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { PlatformApiError, platformApi } from "@/lib/api/client";
import type { UserSummary } from "@/lib/types";

interface AuthContextValue {
  user: UserSummary | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<UserSummary>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({
  children,
  initialUser,
}: {
  children: ReactNode;
  initialUser: UserSummary | null;
}) {
  const [user, setUser] = useState<UserSummary | null>(initialUser);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    try {
      const response = await platformApi.me();
      setUser(response.user);
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) {
        setUser(null);
        return;
      }
      throw error;
    }
  }

  useEffect(() => {
    if (!initialUser) {
      return;
    }
    refresh().catch(() => setUser(null));
  }, [initialUser]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      async login(email, password) {
        const response = await platformApi.login(email, password);
        setUser(response.user);
        return response.user;
      },
      async logout() {
        await platformApi.logout();
        setUser(null);
      },
      refresh,
    }),
    [user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
