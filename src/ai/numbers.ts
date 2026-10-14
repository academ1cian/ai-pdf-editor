// Fixed-point millionths; no binary floating point arithmetic for money or quantities.
export function decimal(value: string): bigint {
  const clean = value.trim().replace(/^[$£€]/, '');
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,6})?$/.test(clean))
    throw new Error('Ambiguous numeric format.');
  const s = clean.replace(/,/g, '');
  const neg = s.startsWith('-');
  const [whole, fraction = ''] = s.replace(/^-/, '').split('.');
  return (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))) * (neg ? -1n : 1n);
}
export function formatNumber(value: bigint, original: string): string {
  const digits = Math.min(6, original.replace(/,/g, '').match(/\.(\d+)/)?.[1].length || 0);
  const scale = 10n ** BigInt(6 - digits),
    negative = value < 0n,
    rounded = ((negative ? -value : value) + scale / 2n) / scale;
  const base = 10n ** BigInt(digits);
  let whole = (rounded / base).toString();
  if (original.includes(',')) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (
    (original.match(/^[$£€]/)?.[0] || '') +
    (negative ? '-' : '') +
    whole +
    (digits ? '.' + (rounded % base).toString().padStart(digits, '0') : '')
  );
}
