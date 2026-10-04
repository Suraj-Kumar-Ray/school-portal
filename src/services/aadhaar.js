// Aadhaar numbers are stored as plain 12 digits ("123456789012") and always
// shown to a human in the familiar 4-4-4 grouped form ("1234 5678 9012").
// Everything that displays an Aadhaar goes through here, so the school, the
// parents and the printed sheet can never disagree about the format.

/** Digits only — what gets written to the database. */
function digits(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

/** "1234 5678 9012" for display; returns the caller's placeholder when empty. */
function format(value, placeholder = '—') {
  const d = digits(value);
  if (!d) return placeholder;
  // group in fours from the left; works for a half-typed number too
  return d.replace(/(\d{4})(?=\d)/g, '$1 ');
}

module.exports = { digits, format };
