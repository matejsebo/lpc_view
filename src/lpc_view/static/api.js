// lpc_view: the server's token and the fetch helpers that carry it.
//
// The token arrives once in the URL lpc_view printed, is kept for the tab, and goes
// with every API request; the URL is cleaned so it is not shared by accident. A page
// without it gets 403 from the API and says so.

let token = "";

// Split a page query into the token and the query that remains once the token is
// taken out. Pure, so Node can test it.
export function splitQuery(search) {
  const params = new URLSearchParams(search);
  const t = params.get("token") || "";
  params.delete("token");
  return { token: t, rest: params.toString() };
}

// Take the token from the page URL (and strip it there) or from the tab's storage.
export function bootstrapToken() {
  const q = splitQuery(location.search);
  let t = q.token;
  if (t) {
    try { sessionStorage.setItem("lpcToken", t); } catch (e) { /* storage may be off */ }
    history.replaceState(null, "", location.pathname + (q.rest ? `?${q.rest}` : "") + location.hash);
  } else {
    try { t = sessionStorage.getItem("lpcToken"); } catch (e) { /* storage may be off */ }
  }
  token = t || "";
  return token;
}

export const apiFetch = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), "X-Lpc-Token": token } });
export const apiUrl = (url) => `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

export async function fetchJson(url, signal) {
  const r = await apiFetch(url, { signal });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}
