import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowClockwise, ArrowCounterClockwise } from '@phosphor-icons/react';
import { fetchInventory, resetInventory } from '../api.js';
import { Button, Panel, Skeleton, cx, inputClass } from '../components/ui.jsx';

const SOURCE_LABEL = { makerspace: 'Makerspace', special: 'Special request' };

// The hardware lab's stock. Ordering in hardware mode takes parts out of it.
export default function InventoryPage() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const run = (call) => {
    setBusy(true);
    return call()
      .then((d) => {
        setItems(d.items);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    run(fetchInventory);
  }, []);

  const reset = () => {
    if (!window.confirm('Reset every item back to its starting stock?')) return;
    run(resetInventory);
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((i) => !q || i.name.toLowerCase().includes(q));
  }, [items, query]);

  const inStock = (items ?? []).filter((i) => !i.source && i.available > 0).length;

  return (
    <motion.main
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="mx-auto w-full max-w-[1100px] px-4 pt-8 pb-16 md:px-6"
    >
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Hardware inventory</h1>
          {items && (
            <p className="mt-1 text-sm text-muted">
              <span className="font-mono text-fg">{inStock}</span> orderable items in stock
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" icon={ArrowCounterClockwise} onClick={reset} disabled={busy || !items}>
            Reset stock
          </Button>
          <Button variant="secondary" icon={ArrowClockwise} onClick={() => run(fetchInventory)} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search items"
        aria-label="Search items"
        className={cx(inputClass, 'mt-6')}
      />

      {error && (
        <div role="alert" className="mt-6 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          Could not load inventory: {error}
        </div>
      )}

      {items === null && !error && <Skeleton className="mt-6 h-72 rounded-panel" />}

      {items && (
        <Panel className="mt-6 divide-y divide-line p-0">
          {shown.length === 0 && <p className="px-5 py-8 text-center text-sm text-muted">No items match.</p>}
          {shown.map((i) => (
            <div key={i.name} className="flex items-center justify-between gap-4 px-5 py-3 text-[15px]">
              <span className={cx('min-w-0 truncate', i.available <= 0 && 'text-muted')}>{i.name}</span>
              <span className="flex shrink-0 items-center gap-3">
                {i.source && <span className="text-xs text-muted">{SOURCE_LABEL[i.source] ?? i.source}</span>}
                <span
                  className={cx(
                    'w-20 text-right font-mono text-sm',
                    i.available <= 0 ? 'text-danger' : i.available <= 2 ? 'text-warn' : 'text-fg'
                  )}
                >
                  {i.available <= 0 ? 'Out' : i.available}
                </span>
              </span>
            </div>
          ))}
        </Panel>
      )}
    </motion.main>
  );
}
