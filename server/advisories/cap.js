const decodeXml = value => String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => decodeXml(xml.match(new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`, 'i'))?.[1]?.replace(/<[^>]+>/g, '').trim() || '');
const blocks = (xml, name) => [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`, 'gi'))].map(match => match[1]);

export function parseCapXml(xml, { now = Date.now(), maxBytes = 1024 * 1024 } = {}) {
  const source = String(xml || '');
  if (Buffer.byteLength(source, 'utf8') > maxBytes || /<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('CAP document is too large or contains forbidden declarations.');
  const alerts = blocks(source, 'alert');
  if (!alerts.length) throw new Error('No CAP alert records were found.');
  return alerts.map(alert => {
    const info = blocks(alert, 'info')[0];
    if (!info) throw new Error('CAP alert has no info block.');
    const onset = tag(info, 'onset') || tag(info, 'effective') || tag(info, 'sent');
    const expires = tag(info, 'expires');
    const sent = tag(alert, 'sent');
    const areas = blocks(info, 'area').map(area => tag(area, 'areaDesc')).filter(Boolean);
    const certainty = tag(info, 'certainty'), severityRaw = tag(info, 'severity').toLowerCase();
    const severity = ({ extreme: 'very_severe', severe: 'severe', moderate: 'moderate', minor: 'mild' })[severityRaw] || 'moderate';
    const validFrom = Date.parse(onset), validTo = Date.parse(expires), issuedAt = Date.parse(sent);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || !Number.isFinite(issuedAt) || validTo <= now || validTo <= validFrom) throw new Error('CAP alert has invalid or expired validity times.');
    return { source: 'CAP', external_id: tag(alert, 'identifier'), hazard: tag(info, 'event').toLowerCase(), severity, areas, issued_at: issuedAt, valid_from: validFrom, valid_to: validTo, headline: tag(info, 'headline').slice(0, 240), text: tag(info, 'description').slice(0, 4000), source_url: tag(alert, 'web').slice(0, 1000), certainty };
  });
}

export function advisoryMatchesSite(advisory, site) {
  const keys = [site.division, site.district, site.name, site.address].map(normalizeArea).filter(Boolean);
  return advisory.areas.some(area => { const normalized = normalizeArea(area); return keys.some(key => normalized.includes(key) || key.includes(normalized)); });
}

export function officialHeatFloor(severity, current = 'Low', enabled = true) {
  const order = ['Low', 'Moderate', 'High', 'Extreme'];
  const map = { mild: 'Moderate', moderate: 'High', severe: 'High', very_severe: 'Extreme', extreme: 'Extreme' };
  if (!enabled) return current;
  const floor = map[String(severity || '').toLowerCase()] || current;
  return order[Math.max(order.indexOf(current), order.indexOf(floor))] === undefined ? current : order[Math.max(order.indexOf(current), order.indexOf(floor))];
}

const normalizeArea = value => String(value || '').toLocaleLowerCase('en').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
