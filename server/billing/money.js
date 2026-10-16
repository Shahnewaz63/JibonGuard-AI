const ZERO_FRACTION = new Set(['BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF']);
const THREE_FRACTION = new Set(['BHD','IQD','JOD','KWD','LYD','OMR','TND']);

export function fractionDigits(currency = 'BDT') {
  const code = String(currency).toUpperCase();
  return ZERO_FRACTION.has(code) ? 0 : THREE_FRACTION.has(code) ? 3 : 2;
}

export function parseMoney(value, currency = 'BDT') {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') throw new TypeError('Money must be a decimal string or number.');
  const digits = fractionDigits(currency), raw = String(value).trim();
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!match || (match[3]?.length || 0) > digits) throw new RangeError(`Invalid ${currency} amount.`);
  const factor = 10n ** BigInt(digits), fraction = (match[3] || '').padEnd(digits, '0');
  const minor = BigInt(match[2]) * factor + BigInt(fraction || '0');
  const signed = match[1] === '-' ? -minor : minor;
  const result = Number(signed);
  if (!Number.isSafeInteger(result)) throw new RangeError('Money amount exceeds the safe integer range.');
  return result;
}

export function formatMoney(amountMinor, currency = 'BDT', locale = 'en-BD') {
  if (!Number.isSafeInteger(amountMinor)) throw new TypeError('Money amount must be a safe integer in minor units.');
  const digits = fractionDigits(currency), factor = 10 ** digits;
  const absolute = Math.abs(amountMinor), major = Math.floor(absolute / factor), minor = absolute % factor;
  const groupedMajor = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(major);
  const fraction = digits ? new Intl.NumberFormat(locale, { useGrouping: false, minimumIntegerDigits: digits, maximumFractionDigits: 0 }).format(minor) : '';
  const template = new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).formatToParts(0);
  const numberParts = new Set(['integer','group','decimal','fraction']);
  let placedNumber = false;
  const rendered = template.map(part => {
    if (!numberParts.has(part.type)) return part.value;
    if (part.type === 'integer') { placedNumber = true; return amountMinor < 0 ? `-${groupedMajor}` : groupedMajor; }
    if (part.type === 'group') return '';
    if (part.type === 'decimal') return digits ? part.value : '';
    if (part.type === 'fraction') return fraction;
    return '';
  });
  if (!placedNumber) return `${amountMinor < 0 ? '-' : ''}${currency} ${groupedMajor}${digits ? `.${fraction}` : ''}`;
  return rendered.join('');
}

export function applyBasisPoints(amountMinor, basisPoints) {
  if (!Number.isSafeInteger(amountMinor) || !Number.isSafeInteger(basisPoints) || basisPoints < 0) throw new TypeError('Amount and nonnegative basis points must be safe integers.');
  const value = (BigInt(amountMinor) * BigInt(basisPoints) + 5000n) / 10000n;
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError('Calculated amount exceeds the safe integer range.');
  return result;
}

export function prorate(amountMinor, unusedSeconds, periodSeconds) {
  if (!Number.isSafeInteger(amountMinor) || !Number.isSafeInteger(unusedSeconds) || !Number.isSafeInteger(periodSeconds) || amountMinor < 0 || unusedSeconds < 0 || periodSeconds <= 0) throw new TypeError('Invalid proration inputs.');
  if (unusedSeconds > periodSeconds) throw new RangeError('Unused time cannot exceed the billing period.');
  const result = Number((BigInt(amountMinor) * BigInt(unusedSeconds) + BigInt(periodSeconds) / 2n) / BigInt(periodSeconds));
  if (!Number.isSafeInteger(result)) throw new RangeError('Prorated amount exceeds the safe integer range.');
  return result;
}
