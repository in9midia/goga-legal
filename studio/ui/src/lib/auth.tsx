import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { User } from "./types";

interface AuthState {
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ user: User }>("/auth/me").then((r) => r.user).catch(() => null),
    staleTime: 60_000,
  });
  const [, force] = useState(0);
  useEffect(() => {
    const onUnauth = () => {
      qc.setQueryData(["me"], null);
      force((x) => x + 1);
    };
    window.addEventListener("studio:unauthorized", onUnauth);
    return () => window.removeEventListener("studio:unauthorized", onUnauth);
  }, [qc]);
  const user = me.data ?? null;
  const value: AuthState = {
    user,
    loading: me.isLoading,
    isAdmin: user?.role === "admin",
    async login(email, password) {
      const r = await api.post<{ user: User }>("/auth/login", { email, password });
      qc.setQueryData(["me"], r.user);
    },
    async logout() {
      await api.post("/auth/logout");
      qc.clear();
      qc.setQueryData(["me"], null);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth fora do AuthProvider");
  return v;
}
