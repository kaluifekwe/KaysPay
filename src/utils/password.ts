export const MIN_PASSWORD_LENGTH = 10;

/** A length-first policy supports memorable passphrases without arbitrary symbols. */
export function passwordValidationError(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}
