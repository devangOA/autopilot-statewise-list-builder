import { COLUMNS } from './schema.js';

function cell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // Guard against spreadsheet formula injection in scraped text.
  const safe = /^[=+@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows, columns = COLUMNS) {
  const lines = [columns.map(cell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(','));
  return lines.join('\n') + '\n';
}

export function headerOnlyCsv(columns = COLUMNS) {
  return columns.map(cell).join(',') + '\n';
}
