import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';

export type AdminRole = 'support' | 'super_admin' | null;
export type AssuranceLevel = 'aal1' | 'aal2' | null;

interface AuthState {
  loading: boolean;
  session: Session | null;
  role: AdminRole;
  needsBootstrap: boolean;
  currentLevel: AssuranceLevel;
  nextLevel: AssuranceLevel;
  refreshRole: () => Promise<void>;
  refreshAssurance: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<AdminRole>(null);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [currentLevel, setCurrentLevel] = useState<AssuranceLevel>(null);
  const [nextLevel, setNextLevel] = useState<AssuranceLevel>(null);

  const refreshAssurance = useCallback(async () => {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) {
      setCurrentLevel(null);
      setNextLevel(null);
      return;
    }
    setCurrentLevel(data.currentLevel as AssuranceLevel);
    setNextLevel(data.nextLevel as AssuranceLevel);
  }, []);

  const loadRole = useCallback(async (hasSession: boolean) => {
    if (!hasSession) {
      setRole(null);
      setNeedsBootstrap(false);
      setCurrentLevel(null);
      setNextLevel(null);
      return;
    }
    const [{ data: roleData }, { data: bootstrapData }] = await Promise.all([
      supabase.rpc('get_my_admin_role'),
      supabase.rpc('admin_panel_needs_bootstrap'),
      refreshAssurance(),
    ]);
    setRole((roleData as AdminRole) ?? null);
    setNeedsBootstrap(bootstrapData === true);
  }, [refreshAssurance]);

  useEffect(() => {
    const initialise = async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
      await loadRole(!!data.session);
      setLoading(false);
    };

    void initialise();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      // Supabase advises against awaiting another auth operation inside this
      // callback. Defer the role/AAL refresh to avoid auth-lock deadlocks.
      setTimeout(() => { void loadRole(!!newSession); }, 0);
    });

    return () => sub.subscription.unsubscribe();
  }, [loadRole]);

  const refreshRole = useCallback(async () => {
    await loadRole(!!session);
  }, [loadRole, session]);

  return (
    <AuthContext.Provider value={{ loading, session, role, needsBootstrap, currentLevel, nextLevel, refreshRole, refreshAssurance }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
