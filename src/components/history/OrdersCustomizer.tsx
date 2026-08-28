'use client';

import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, GripVertical, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DEFAULT_ORDERS_COLUMN_ORDER,
  defaultOrdersPreferences,
  isDefaultOrdersPreferences,
  type ColumnId,
  type OrdersPreferences,
} from './OrdersView';

interface OrdersCustomizerProps {
  open: boolean;
  prefs: OrdersPreferences;
  onChange: (next: OrdersPreferences) => void;
  onClose: () => void;
}

const COLUMN_META: Record<ColumnId, { label: string; description?: string }> = {
  account: { label: 'Account ID' },
  platform: { label: 'Platform' },
  server: { label: 'Server' },
  nickname: { label: 'Nickname' },
  symbol: { label: 'Symbol' },
  side: { label: 'Side' },
  volume: { label: 'Volume' },
  open: { label: 'Open price' },
  close: { label: 'Close price' },
  sl: { label: 'Stop loss' },
  tp: { label: 'Take profit' },
  openTime: { label: 'Open time' },
  closeTime: { label: 'Close time' },
  commission: { label: 'Commission' },
  swap: { label: 'Swap' },
  profit: { label: 'Profit' },
  net: { label: 'Net P&L' },
  ticket: { label: 'Ticket' },
};

export function OrdersCustomizer({ open, prefs, onChange, onClose }: OrdersCustomizerProps) {
  const [draft, setDraft] = useState<OrdersPreferences>(prefs);
  const [draggingId, setDraggingId] = useState<ColumnId | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ id: ColumnId; pos: 'before' | 'after' } | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(prefs);
      setDraggingId(null);
      setDropIndicator(null);
    }
  }, [open, prefs]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const apply = (next: OrdersPreferences) => {
    setDraft(next);
    onChange(next);
  };

  const visibleCount = draft.columnOrder.reduce(
    (n, id) => n + (draft.visible[id] !== false ? 1 : 0),
    0
  );

  const toggleVisible = (id: ColumnId) => {
    const next = !(draft.visible[id] !== false);
    if (!next && visibleCount <= 1) return;
    apply({ ...draft, visible: { ...draft.visible, [id]: next } });
  };

  const moveColumn = (sourceId: ColumnId, targetId: ColumnId, pos: 'before' | 'after') => {
    if (sourceId === targetId) return;
    const order = draft.columnOrder.filter((id) => id !== sourceId);
    const idx = order.indexOf(targetId);
    if (idx === -1) return;
    order.splice(pos === 'before' ? idx : idx + 1, 0, sourceId);
    apply({ ...draft, columnOrder: order });
  };

  const handleReset = () => apply(defaultOrdersPreferences());
  const isDirty = !isDefaultOrdersPreferences(draft);

  const orderedIds = (() => {
    const seen = new Set<ColumnId>();
    const out: ColumnId[] = [];
    for (const id of draft.columnOrder) {
      if (!seen.has(id)) {
        out.push(id);
        seen.add(id);
      }
    }
    for (const id of DEFAULT_ORDERS_COLUMN_ORDER) {
      if (!seen.has(id)) {
        out.push(id);
        seen.add(id);
      }
    }
    return out;
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-gray-900">Orders columns</h3>
            <p className="mt-0.5 text-sm text-gray-500">Drag to reorder, eye to hide.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded p-1 text-gray-500 hover:text-gray-400"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto [&>*:last-child]:border-b-0">
          {orderedIds.map((id) => {
            const meta = COLUMN_META[id];
            if (!meta) return null;
            const visible = draft.visible[id] !== false;
            const isDragging = draggingId === id;
            const indicator = dropIndicator?.id === id ? dropIndicator.pos : null;
            const toggleDisabled = visible && visibleCount <= 1;
            return (
              <ColumnRow
                key={id}
                id={id}
                label={meta.label}
                description={meta.description}
                visible={visible}
                isDragging={isDragging}
                dropIndicator={indicator}
                toggleDisabled={toggleDisabled}
                onToggle={() => toggleVisible(id)}
                onDragStart={() => setDraggingId(id)}
                onDragEnd={() => {
                  setDraggingId(null);
                  setDropIndicator(null);
                }}
                onDragOverHover={(pos) => setDropIndicator({ id, pos })}
                onDragLeave={() => {
                  setDropIndicator((cur) => (cur?.id === id ? null : cur));
                }}
                onDrop={(sourceId, pos) => {
                  setDropIndicator(null);
                  setDraggingId(null);
                  moveColumn(sourceId, id, pos);
                }}
              />
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-gray-200 bg-gray-50/60 px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={!isDirty}
            className="h-9 shrink-0 rounded-lg border border-gray-200 bg-gray-100 text-gray-700 hover:bg-gray-200 hover:text-gray-800"
          >
            Reset
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            className="h-9 shrink-0 rounded-lg border border-green-200 bg-green-50 text-green-700 hover:bg-green-100 hover:text-green-800"
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ColumnRowProps {
  id: ColumnId;
  label: string;
  description?: string;
  visible: boolean;
  isDragging: boolean;
  dropIndicator: 'before' | 'after' | null;
  toggleDisabled?: boolean;
  onToggle: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverHover: (pos: 'before' | 'after') => void;
  onDragLeave: () => void;
  onDrop: (sourceId: ColumnId, pos: 'before' | 'after') => void;
}

function ColumnRow({
  id,
  label,
  description,
  visible,
  isDragging,
  dropIndicator,
  toggleDisabled,
  onToggle,
  onDragStart,
  onDragEnd,
  onDragOverHover,
  onDragLeave,
  onDrop,
}: ColumnRowProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const dragArmedRef = useRef(false);

  return (
    <div
      ref={rowRef}
      draggable
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        dragArmedRef.current = !!t.closest('[data-drag-handle="true"]');
      }}
      onDragStart={(e) => {
        if (!dragArmedRef.current) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
        if (rowRef.current) {
          try {
            e.dataTransfer.setDragImage(rowRef.current, 12, 12);
          } catch {
          }
        }
        onDragStart();
      }}
      onDragEnd={() => {
        dragArmedRef.current = false;
        onDragEnd();
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('text/plain')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = e.currentTarget.getBoundingClientRect();
        const offsetY = e.clientY - rect.top;
        onDragOverHover(offsetY < rect.height / 2 ? 'before' : 'after');
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && e.currentTarget.contains(next)) return;
        onDragLeave();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const sourceId = e.dataTransfer.getData('text/plain') as ColumnId;
        if (sourceId && sourceId !== id && dropIndicator) {
          onDrop(sourceId, dropIndicator);
        }
      }}
      className={cn(
        'relative flex items-center gap-3 border-b border-gray-200 px-3 py-2',
        isDragging && 'opacity-60',
        !visible && 'bg-gray-50'
      )}
    >
      <span
        data-drag-handle="true"
        className="flex h-6 w-6 shrink-0 cursor-grab items-center justify-center text-gray-400 hover:text-gray-700 active:cursor-grabbing"
        aria-label="Drag handle"
      >
        <GripVertical className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn('text-sm font-medium', visible ? 'text-gray-900' : 'text-gray-500')}>
          {label}
        </div>
        {description && <div className="text-[11px] text-gray-500">{description}</div>}
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={toggleDisabled}
        className={cn(
          'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded p-1 hover:text-gray-400',
          visible ? 'text-gray-700' : 'text-gray-400',
          toggleDisabled && 'cursor-not-allowed opacity-50'
        )}
        aria-label={visible ? 'Hide column' : 'Show column'}
      >
        {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
      </button>
      {dropIndicator === 'before' && (
        <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-blue-500" />
      )}
      {dropIndicator === 'after' && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-blue-500" />
      )}
    </div>
  );
}
