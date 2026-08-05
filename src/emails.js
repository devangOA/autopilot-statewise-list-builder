const clean = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');

/**
 * The six required permutations, in the order the CSV expects them.
 * These are PATTERN GUESSES, never verified — the caller marks them as such.
 */
export function guessEmails(first, last, domain) {
  const f = clean(first);
  const l = clean(last);
  const d = String(domain || '').toLowerCase().replace(/^www\./, '');
  if (!f || !l || !d) return ['', '', '', '', '', ''];
  return [
    `${f}@${d}`,
    `${f}.${l}@${d}`,
    `${f}${l}@${d}`,
    `${f[0]}${l}@${d}`,
    `${f[0]}.${l}@${d}`,
    `${f}${l[0]}@${d}`,
  ];
}

export const GUESS_DISCLAIMER = 'Guessed emails are UNVERIFIED pattern permutations - not published addresses.';
