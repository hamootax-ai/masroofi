// GitHub "inbox" repo client: the iOS Shortcut PUTs each bank SMS as inbox/<time>.txt, the app pulls and deletes them.
const API = 'https://api.github.com';

function headers(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

export function decodeB64Utf8(b64) {
  const bin = atob(String(b64 || '').replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

async function gh(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method, cache: 'no-store',
    headers: { ...headers(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

const enc = p => p.split('/').map(encodeURIComponent).join('/');

/** List inbox files, oldest first. Empty/missing folder = []. */
export async function listInbox(token, repo) {
  const r = await gh(token, 'GET', `/repos/${repo}/contents/inbox`);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`${r.status}: ${r.status === 401 ? 'التوكن غلط أو منتهي' : r.status === 403 ? 'التوكن ما إله صلاحية على الريبو' : r.data?.message || ''}`);
  return (Array.isArray(r.data) ? r.data : []).filter(f => f.type === 'file').sort((a, b) => a.name.localeCompare(b.name));
}

/** Returns {text, sha}. */
export async function readFile(token, repo, path) {
  const r = await gh(token, 'GET', `/repos/${repo}/contents/${enc(path)}`);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return { text: decodeB64Utf8(r.data.content), sha: r.data.sha };
}

export async function deleteFile(token, repo, path, sha) {
  const r = await gh(token, 'DELETE', `/repos/${repo}/contents/${enc(path)}`, { message: 'imported', sha });
  return r.ok;
}
