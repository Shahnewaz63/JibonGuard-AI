import app from '../server.js';

export default function handler(req, res) {
  const requestUrl = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
  const route = requestUrl.searchParams.get('__jg_path');
  if (route !== null) {
    requestUrl.searchParams.delete('__jg_path');
    const suffix = requestUrl.searchParams.toString();
    req.url = `/api/${route.replace(/^\/+/, '')}${suffix ? `?${suffix}` : ''}`;
  }
  return app(req, res);
}
