// Thin fetch wrapper for the admin API. Sends the session cookie (httpOnly,
// so the browser attaches it automatically), parses JSON, and routes 401s to
// the login screen.

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

// VITE_API_BASE lets a separately-hosted dashboard (e.g. Vercel) point at the
// Express/Render API. Empty by default = same-origin, matching Node/Express
// deployments.
const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    window.location.hash = '#/login';
    throw new ApiError(401, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
