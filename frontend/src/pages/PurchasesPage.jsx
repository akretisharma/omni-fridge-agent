import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchPurchases } from '../api.js';

const STATUS_CLASS = {
  approved: 'ok',
  pending: 'warn',
  submitted: 'warn',
  error: 'bad',
  rejected: 'bad',
};

// Group the flat purchase list into one card per order (same timestamp + goal).
function groupOrders(purchases) {
  const orders = [];
  for (const p of purchases) {
    const last = orders[orders.length - 1];
    if (last && last.createdAt === p.createdAt) last.items.push(p);
    else orders.push({ createdAt: p.createdAt, goal: p.goal, items: [p] });
  }
  return orders;
}

export default function PurchasesPage() {
  const [purchases, setPurchases] = useState(null);
  const [error, setError] = useState(null);

  const load = () =>
    fetchPurchases()
      .then((d) => {
        setPurchases(d.purchases);
        setError(null);
      })
      .catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const orders = purchases ? groupOrders(purchases) : [];

  return (
    <main className="single">
      <section>
        <div className="row">
          <h2>Zip purchases</h2>
          <button onClick={load}>Refresh</button>
        </div>

        {error && <p className="bad-text">Could not load purchases: {error}</p>}
        {purchases && orders.length === 0 && (
          <p className="hint">
            No purchases yet. Scan the fridge on the <Link to="/">Live camera</Link> page and
            purchase what's missing.
          </p>
        )}

        {orders.map((order) => (
          <div className="block" key={order.createdAt}>
            <h3>
              {order.goal || 'Purchase'}{' '}
              <span className="hint">{new Date(order.createdAt * 1000).toLocaleString()}</span>
            </h3>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Qty</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.quantity ? `${p.quantity} ${p.unit || ''}` : '-'}</td>
                    <td>
                      <span className={`badge ${STATUS_CLASS[p.status] || 'warn'}`}>{p.status}</span>
                      {p.error && <div className="hint">{p.error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>
    </main>
  );
}
