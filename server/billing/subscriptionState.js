const ALLOWED = Object.freeze({
  trialing: new Set(['active','past_due','suspended','cancelled','expired']),
  active: new Set(['past_due','suspended','cancelled']),
  past_due: new Set(['active','suspended','cancelled','expired']),
  suspended: new Set(['active','cancelled','expired']),
  cancelled: new Set(['active','expired']),
  expired: new Set(['active']),
});

export function canTransitionSubscription(from, to) { return Boolean(ALLOWED[from]?.has(to)); }

export function transitionSubscription(subscription, to, { now = Math.floor(Date.now() / 1000), reason = '' } = {}) {
  if (!subscription || !canTransitionSubscription(subscription.status, to)) throw new Error(`Subscription transition is not allowed: ${subscription?.status || 'unknown'} -> ${to}.`);
  return { ...subscription, status: to, updated_at: now, transition_reason: String(reason).slice(0, 1000) };
}
