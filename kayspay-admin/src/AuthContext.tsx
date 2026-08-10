import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';

export type AdminRole = 'support' | 'super_admin' | null;

interface AuthState {
  loading: boolean;
  session: Session | null;
  role: AdminRole;
  needsBootstrap: boolean;
  refreshRole: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<AdminRole>(null);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);

  const loadRole = useCallback(async (hasSession: boolean) => {
    if (!hasSession) {
      setRole(null);
      setNeedsBootstrap(false);
      return;
    }
    const [{ data: roleData }, { data: bootstrapData }] = await Promise.all([
      supabase.rpc('get_my_admin_role'),
      supabase.rpc('admin_panel_needs_bootstrap'),
    ]);
    setRole((roleData as AdminRole) ?? null);
    setNeedsBootstrap(bootstrapData === true);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await loadRole(!!data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      setSession(newSession);
      await loadRole(!!newSession);
    });

    return () => sub.subscription.unsubscribe();
  }, [loadRole]);

  const refreshRole = useCallback(async () => {
    await loadRole(!!session);
  }, [loadRole, session]);

  return (
    <AuthContext.Provider value={{ loading, session, role, needsBootstrap, refreshRole }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
