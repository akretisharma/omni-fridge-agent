// Thin wrappers over the FastAPI backend. Errors come back as {"error": "..."}.
async function request(path, options = {}) {
  const res = await fetch(path, { cache: 'no-store', ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const post = (path, body) =>
  request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const fetchIntent = (body) => post('/api/intent', body);
export const visionCheck = (imageBase64, ingredients, mode) =>
  post('/api/vision-check', { imageBase64, ingredients, mode });
export const fetchPrices = (items, goal, mode) => post('/api/prices', { items, goal, mode });
export const purchaseItems = (items, goal, mode, prices) =>
  post('/api/purchase', { items, goal, mode, prices });
export const fetchPurchases = () => request('/api/purchases');
export const clearPurchases = () => request('/api/purchases', { method: 'DELETE' });
export const fetchInventory = () => request('/api/inventory');
export const resetInventory = () => request('/api/inventory/reset', { method: 'POST' });
export const fetchOakStatus = () => request('/api/oak/status');
