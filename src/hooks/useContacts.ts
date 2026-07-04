import { useCallback, useEffect, useMemo, useState } from 'react';
import { contactsService, PickedContact, ContactPermission } from '../services/contacts.service';

type PermissionState = 'loading' | ContactPermission;

/**
 * Loads phone contacts once (requesting permission if needed), caches them in
 * memory, and exposes a debounced search over name + number.
 */
export function useContacts() {
  const [all, setAll] = useState<PickedContact[]>([]);
  const [permission, setPermission] = useState<PermissionState>('loading');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    let status = await contactsService.getPermissionStatus();
    if (status !== 'granted') {
      const granted = await contactsService.requestPermission();
      status = granted ? 'granted' : 'denied';
    }
    setPermission(status);
    if (status === 'granted') {
      try {
        setAll(await contactsService.getContacts(forceRefresh));
      } catch {
        setAll([]);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const reload = useCallback(() => load(true), [load]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim().toLowerCase()), 200);
    return () => clearTimeout(t);
  }, [query]);

  const contacts = useMemo(() => {
    if (!debounced) return all;
    const digits = debounced.replace(/\D/g, '');
    return all.filter(
      (c) =>
        c.name.toLowerCase().includes(debounced) ||
        (digits.length > 0 && c.phone.includes(digits)),
    );
  }, [all, debounced]);

  return { contacts, loading, permission, query, setQuery, reload };
}
