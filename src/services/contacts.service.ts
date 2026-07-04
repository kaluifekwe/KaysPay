import * as Contacts from 'expo-contacts';
import { detectNgNetwork, normalizeNgPhone, NgNetwork } from '../utils/phone';

export interface PickedContact {
  id: string;
  name: string;
  phone: string; // canonical 0XXXXXXXXXX
  network: NgNetwork;
}

export type ContactPermission = 'granted' | 'denied' | 'undetermined';

// Cached for the app session so re-opening the picker (Airtime -> Data ->
// Airtime, etc.) is instant instead of re-reading + re-processing the whole
// address book every time. Cleared only via getContacts(true).
let cache: PickedContact[] | null = null;

const CHUNK_SIZE = 300;

/** Yield to the JS event loop so a huge contact list can't freeze the UI. */
function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Reads phone contacts ON-DEVICE only. The full address book never leaves the
 * phone — only a single selected number is later sent to the purchase endpoint.
 */
export const contactsService = {
  async getPermissionStatus(): Promise<ContactPermission> {
    try {
      const { status } = await Contacts.getPermissionsAsync();
      return status as ContactPermission;
    } catch {
      return 'denied';
    }
  },

  async requestPermission(): Promise<boolean> {
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      return status === 'granted';
    } catch {
      return false;
    }
  },

  /**
   * Returns deduped, valid Nigerian contacts with detected network, sorted by
   * name. A contact with several numbers yields one entry per routable number.
   * Processes in chunks (yielding between them) so a phone with thousands of
   * contacts doesn't block the UI thread on first load. Pass `forceRefresh`
   * to bypass the in-memory cache (e.g. after the user edits their contacts).
   */
  async getContacts(forceRefresh = false): Promise<PickedContact[]> {
    if (cache && !forceRefresh) return cache;

    const { data } = await Contacts.getContactsAsync({
      fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
    });

    const seen = new Set<string>();
    const out: PickedContact[] = [];

    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      const numbers = c.phoneNumbers;
      if (numbers && numbers.length > 0) {
        for (const pn of numbers) {
          const phone = normalizeNgPhone(pn.number || '');
          if (!phone) continue; // not a valid NG number
          const network = detectNgNetwork(phone);
          if (!network) continue; // not a routable carrier
          if (seen.has(phone)) continue; // dedupe across all contacts
          seen.add(phone);
          out.push({
            id: `${c.id ?? 'c'}_${phone}`,
            name: (c.name || phone).trim(),
            phone,
            network,
          });
        }
      }

      if (i > 0 && i % CHUNK_SIZE === 0) {
        await yieldToUI();
      }
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    cache = out;
    return out;
  },
};
