export function phoneForCalling(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (/^0\d{10}$/.test(digits)) return `+234${digits.slice(1)}`;
  if (/^234\d{10}$/.test(digits)) return `+${digits}`;
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

export function formatPhoneForAdmin(phone: string | null): string {
  if (!phone) return 'No phone number provided';
  const callable = phoneForCalling(phone);
  const digits = callable.replace(/\D/g, '');
  if (/^234\d{10}$/.test(digits)) {
    const local = `0${digits.slice(3)}`;
    return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
  }
  return phone;
}
