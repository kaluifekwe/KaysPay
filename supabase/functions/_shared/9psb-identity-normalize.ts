// Turns user_kyc.verified_record (the raw NIN/BVN provider payload,
// whichever of Prembly/CheckMyNINBVN answered — see kyc-verify-nin's own
// extractRecord) into 9PSB's exact open_wallet field set. Cannot reuse
// nin-verify's normalizeDob/normalizeGender — those target a different
// downstream shape (kyc-verify-nin's own comparison logic), not 9PSB's
// dd/MM/yyyy date format or 0/1 gender encoding.
//
// firstname/middlename/surname are already normalized by kyc-verify-nin's
// extractRecord before storage, confirmed by reading that file directly.
// dob/gender/phone reuse the exact key-variant list bvn-verify/index.ts's
// own pick() already normalizes against (same provider shapes). Address has
// no existing normalizer anywhere in this codebase to copy from — this
// codebase has never needed a customer's residential address before 9PSB.
// The key names below are a best-effort guess at Prembly/CheckMyNINBVN's
// residence_* field naming (per ninbvn-client.ts's own shape comment) and
// MUST be confirmed against a real verified_record during closed testing
// (see plan's open risks) before this is trusted for a real customer.

function pick(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = record[k];
    if (v !== undefined && v !== null && v !== "") return typeof v === "string" ? v : String(v);
  }
  return undefined;
}

/** dd/MM/yyyy, as 9PSB's open_wallet requires — verified_record's dob is typically YYYY-MM-DD by the time it's stored (see nin-verify's own normalizeDob precedent for the same Prembly DD-MM-YYYY quirk). */
function toNinePsbDob(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const dmy = raw.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (dmy) return `${dmy[1]}/${dmy[2]}/${dmy[3]}`;
  return undefined;
}

// 9PSB's docx and its own open_wallet section disagree internally on which
// of 0/1 maps to which gender — this constant is a placeholder pending
// empirical confirmation against sandbox (plan's verification step 8), kept
// as a single named point so the mapping is obvious to flip once confirmed.
const NINEPSB_GENDER_MALE = 0;
const NINEPSB_GENDER_FEMALE = 1;

export interface NinePsbIdentityFields {
  lastName: string;
  otherNames: string;
  phoneNo: string;
  gender: 0 | 1;
  dateOfBirth: string;
  address: string;
  bvn?: string;
  nationalIdentityNo?: string;
  email?: string;
}

export class IdentityNormalizeError extends Error {}

export function normalizeForNinePsb(
  verifiedRecord: Record<string, unknown>,
  fallbackPhone: string | undefined,
  fallbackEmail: string | undefined,
): NinePsbIdentityFields {
  const surname = pick(verifiedRecord, "surname", "lastname");
  const firstname = pick(verifiedRecord, "firstname");
  const middlename = pick(verifiedRecord, "middlename");
  if (!surname || !firstname) {
    throw new IdentityNormalizeError("Verified KYC record is missing a name — cannot provision a 9PSB wallet yet");
  }

  const dobRaw = pick(verifiedRecord, "dob", "dateOfBirth", "DateOfBirth", "birthdate");
  const dateOfBirth = toNinePsbDob(dobRaw);
  if (!dateOfBirth) {
    throw new IdentityNormalizeError("Verified KYC record has no usable date of birth for 9PSB");
  }

  const genderRaw = pick(verifiedRecord, "gender")?.toLowerCase();
  const gender: 0 | 1 = genderRaw?.startsWith("f") ? NINEPSB_GENDER_FEMALE : NINEPSB_GENDER_MALE;

  const phoneNo = pick(verifiedRecord, "phone", "phoneNumber1", "phoneNumber", "phone_number") || fallbackPhone;
  if (!phoneNo) {
    throw new IdentityNormalizeError("No phone number available for 9PSB wallet creation");
  }

  const address = pick(
    verifiedRecord,
    "residentialAddress",
    "residential_address",
    "residenceAddress",
    "residence_AdressLine1",
    "address",
  ) || "";

  const bvn = pick(verifiedRecord, "bvn");
  const nin = pick(verifiedRecord, "nin", "number");

  return {
    lastName: surname,
    otherNames: [firstname, middlename].filter(Boolean).join(" "),
    phoneNo,
    gender,
    dateOfBirth,
    address,
    bvn,
    nationalIdentityNo: nin,
    email: fallbackEmail,
  };
}
