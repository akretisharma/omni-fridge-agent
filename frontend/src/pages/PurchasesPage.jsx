import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { ArrowClockwise, CheckCircle, Clock, Trash, VideoCamera, WarningCircle } from '@phosphor-icons/react';
import { clearPurchases, fetchPurchases } from '../api.js';
import { Button, Panel, Skeleton, buttonClass, cx } from '../components/ui.jsx';

const STATUS = {
  approved: { icon: CheckCircle, tone: 'text-ok', label: 'Approved' },
  pending: { icon: Clock, tone: 'text-warn', label: 'Pending' },
  submitted: { icon: Clock, tone: 'text-warn', label: 'Submitted' },
  'awaiting approval': { icon: Clock, tone: 'text-warn', label: 'Awaiting approval' },
  canceled: { icon: WarningCircle, tone: 'text-muted', label: 'Canceled' },
  closed: { icon: CheckCircle, tone: 'text-muted', label: 'Closed' },
  paused: { icon: Clock, tone: 'text-muted', label: 'Paused' },
  error: { icon: WarningCircle, tone: 'text-danger', label: 'Failed' },
  rejected: { icon: WarningCircle, tone: 'text-danger', label: 'Rejected' },
};

function StatusBadge({ status }) {
  const s = STATUS[status] || STATUS.pending;
  const Icon = s.icon;
  return (
    <span
      className={cx(
        'inline-flex h-7 min-w-[6.75rem] items-center justify-center gap-1.5 rounded-full border border-current/25 bg-current/10 px-3 text-xs font-medium',
        s.tone
      )}
    >
      <Icon size={14} weight="regular" aria-hidden />
      {s.label}
    </span>
  );
}

// Group the flat purchase list into one card per order (same timestamp).
function groupOrders(purchases) {
  const orders = [];
  for (const p of purchases) {
    const last = orders[orders.length - 1];
    if (last && last.createdAt === p.createdAt) last.items.push(p);
    else orders.push({ createdAt: p.createdAt, goal: p.goal, items: [p] });
  }
  return orders;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Records from a failed request have no amount, so they don't count towards a total.
const sumAmount = (items) => items.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
const money = (n) => `$${n.toFixed(2)}`;

function Stat({ value, label }) {
  return (
    <div>
      <p className="font-mono text-3xl font-medium tracking-tight md:text-4xl">{value}</p>
      <p className="mt-1 text-sm text-muted">{label}</p>
    </div>
  );
}

export default function PurchasesPage() {
  const [purchases, setPurchases] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = () => {
    setRefreshing(true);
    return fetchPurchases()
      .then((d) => {
        setPurchases(d.purchases);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setRefreshing(false));
  };

  const clear = () => {
    if (!window.confirm('Clear all purchase history? This only deletes local records, not Zip POs.')) return;
    setClearing(true);
    clearPurchases()
      .then((d) => {
        setPurchases(d.purchases ?? []);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setClearing(false));
  };

  useEffect(() => {
    load();
  }, []);

  const orders = purchases ? groupOrders(purchases) : [];
  const count = (...names) => (purchases ?? []).filter((p) => names.includes(p.status)).length;

  return (
    <motion.main
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="mx-auto w-full max-w-[1100px] px-4 pt-8 pb-16 md:px-6"
    >
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Zip purchases</h1>
        <div className="flex items-center gap-2">
          <Button variant="ghost" icon={Trash} onClick={clear} disabled={clearing || !purchases?.length}>
            {clearing ? 'Clearing…' : 'Clear'}
          </Button>
          <Button variant="secondary" icon={ArrowClockwise} onClick={load} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-6 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          Could not load purchases: {error}
        </div>
      )}

      {purchases === null && !error && (
        <div className="mt-8 flex flex-col gap-6" aria-busy="true" aria-label="Loading purchases">
          <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
          <Skeleton className="h-56 rounded-panel" />
        </div>
      )}

      {purchases && orders.length === 0 && (
        <Panel className="mt-8 grid place-content-center justify-items-center gap-3 px-6 py-16 text-center">
          <VideoCamera size={36} weight="regular" className="text-muted" aria-hidden />
          <h2 className="text-xl font-semibold tracking-tight">No orders yet</h2>
          <p className="max-w-[44ch] text-sm text-muted">
            Scan the shelf on the Live page, then order what is missing. Every request shows up here with its status.
          </p>
          <Link to="/" className={buttonClass('primary', 'mt-2')}>
            Go to Live
          </Link>
        </Panel>
      )}

      {purchases && orders.length > 0 && (
        <>
          <div className="mt-8 grid grid-cols-2 gap-6 md:grid-cols-5">
            <Stat value={money(sumAmount(purchases))} label="Estimated total" />
            <Stat value={orders.length} label="Orders" />
            <Stat value={purchases.length} label="Items" />
            <Stat value={count('approved')} label="Approved" />
            <Stat value={count('pending', 'submitted', 'awaiting approval')} label="Awaiting approval" />
          </div>

          <div className="mt-10 flex flex-col gap-5">
            {orders.map((order, i) => (
              <motion.div
                key={order.createdAt}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: Math.min(i, 5) * 0.06, ease: [0.16, 1, 0.3, 1] }}
              >
                <Panel className="p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <h2 className="text-xl font-semibold capitalize tracking-tight">{order.goal || 'Purchase'}</h2>
                    {order.items.some((p) => p.amount != null) && (
                      <p className="font-mono text-2xl font-medium tracking-tight">
                        {money(sumAmount(order.items))}
                      </p>
                    )}
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted">
                    {plural(order.items.length, 'item')} · {new Date(order.createdAt * 1000).toLocaleString()}
                  </p>
                  <ul className="mt-3 flex flex-col">
                    {order.items.map((p) => (
                      <li
                        key={p.id}
                        className="flex items-start justify-between gap-4 rounded-xl px-3 py-2.5 hover:bg-surface-2"
                      >
                        <div className="min-w-0">
                          <p className="text-[15px]">{p.name}</p>
                          {(p.vendor || p.request_number || p.po_number) && (
                            <p className="mt-0.5 font-mono text-xs text-muted">
                              {[
                                p.vendor,
                                // Hardware orders show what the lab has left after this order, in place of the Zip number.
                                p.remaining != null ? `${p.remaining} remaining` : p.request_number || p.po_number,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </p>
                          )}
                          {p.error && <p className="mt-0.5 break-words text-xs text-danger">{p.error}</p>}
                        </div>
                        <div className="flex shrink-0 items-center gap-4">
                          <span className="text-right">
                            {p.amount && <span className="block font-mono text-sm">${p.amount}</span>}
                            <span className="block font-mono text-xs text-muted">
                              {p.quantity ? `${p.quantity} ${p.unit || ''}`.trim() : ''}
                            </span>
                          </span>
                          <StatusBadge status={p.status} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </Panel>
              </motion.div>
            ))}
          </div>
        </>
      )}
    </motion.main>
  );
}
