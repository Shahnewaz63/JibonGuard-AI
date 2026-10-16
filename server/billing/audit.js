import { randomUUID } from 'node:crypto';

const SECRET_KEY = /password|secret|token|cookie|api[_-]?key|credential|otp|recovery|authorization/i;

export function redactAuditValue(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 200).map(item => redactAuditValue(item, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 4000) : value;
  return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redactAuditValue(item, depth + 1)]));
}

export function writeAdminAudit(db, { adminId = null, role = '', action, targetType = '', targetId = '', ip = '', userAgent = '', before = null, after = null, reason = '', now = Math.floor(Date.now() / 1000) }) {
  if (!action || typeof action !== 'string') throw new TypeError('Audit action is required.');
  const id = randomUUID();
  db.prepare('INSERT INTO admin_audit_log(id,admin_id,admin_role,action,target_type,target_id,ip,user_agent,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, adminId, role, action.slice(0, 100), targetType.slice(0, 80), String(targetId).slice(0, 120), String(ip).slice(0, 100), String(userAgent).slice(0, 300), before == null ? null : JSON.stringify(redactAuditValue(before)), after == null ? null : JSON.stringify(redactAuditValue(after)), reason.slice(0, 2000), now);
  return id;
}
