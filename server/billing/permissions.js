export const PERMISSIONS = Object.freeze({
  dashboard_read: ['super_admin','finance','support','viewer'],
  organizations_read: ['super_admin','finance','support','viewer'],
  organizations_edit: ['super_admin','support'],
  organizations_suspend: ['super_admin','support'],
  organizations_hard_delete: ['super_admin'],
  plans_read: ['super_admin','finance','viewer'],
  plans_write: ['super_admin','finance'],
  billing_read: ['super_admin','finance','viewer'],
  billing_write: ['super_admin','finance'],
  usage_read: ['super_admin','finance','support','viewer'],
  expenses_write: ['super_admin','finance'],
  audit_read: ['super_admin','viewer'],
  admins_manage: ['super_admin'],
  settings_write: ['super_admin'],
  data_export: ['super_admin','finance','support'],
});

export function hasPermission(role, permission) {
  return PERMISSIONS[permission]?.includes(role) ?? false;
}

export function requirePermission(role, permission) {
  if (!hasPermission(role, permission)) {
    const error = new Error('You do not have permission to perform this action.');
    error.status = 403;
    throw error;
  }
  return true;
}
