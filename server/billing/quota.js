export function calculateQuota({ included = 0, used = 0, limit = null, unlimited = false, policy = 'soft_warn', warningThresholds = [80, 100], safetyExempt = false, safetyAlert = false } = {}) {
  for (const value of [included, used]) if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Quota values must be nonnegative safe integers.');
  if (!['block','charge_overage','soft_warn'].includes(policy)) throw new TypeError('Unknown overage policy.');
  const isUnlimited = unlimited || limit === -1 || limit == null;
  const available = isUnlimited ? null : Math.max(0, limit);
  const percent = available === null || available === 0 ? (used > 0 && available === 0 ? 100 : 0) : Math.min(100, Math.floor(used * 100 / available));
  const overage = available === null ? 0 : Math.max(0, used - available);
  const exempt = safetyAlert && safetyExempt;
  const blocked = overage > 0 && policy === 'block' && !exempt;
  return { used, included, limit: available, percent, overage, warning: warningThresholds.some(threshold => percent >= threshold), blocked, safetyExemptApplied: exempt, policy };
}

export function hasPlanFeature(planFeatures, featureKey) {
  return Boolean(planFeatures && planFeatures[featureKey] === true);
}
