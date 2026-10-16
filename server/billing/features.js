export const FEATURE_REGISTRY = Object.freeze([
  { key: 'ai_chat', label: 'AI chat' },
  { key: 'ai_alert_automation', label: 'AI alert automation' },
  { key: 'simulator', label: 'Alert simulator' },
  { key: 'voice_alerts', label: 'Voice alerts' },
  { key: 'csv_import', label: 'CSV import' },
  { key: 'data_export', label: 'Data export' },
  { key: 'break_planner', label: 'Break planner' },
  { key: 'nowcasting', label: 'Nowcasting' },
  { key: 'heat_triage', label: 'Heat triage' },
  { key: 'ai_reports', label: 'AI reports' },
  { key: 'official_advisories', label: 'Official advisories' },
  { key: 'priority_support', label: 'Priority support' },
  { key: 'api_access', label: 'API access' },
  { key: 'custom_branding', label: 'Custom branding' },
]);

export const FEATURE_KEYS = Object.freeze(FEATURE_REGISTRY.map(feature => feature.key));
export const isKnownFeature = key => FEATURE_KEYS.includes(key);
