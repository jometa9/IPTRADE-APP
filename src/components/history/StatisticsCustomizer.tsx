'use client';

import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, GripVertical, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  STATS_SECTIONS,
  defaultStatsPreferences,
  isDefaultStatsPreferences,
  type StatsPreferences,
  type StatsSectionId,
} from './statisticsPrefs';

interface StatisticsCustomizerProps {
  open: boolean;
  prefs: StatsPreferences;
  onChange: (next: StatsPreferences) => void;
  onClose: () => void;
}

export function StatisticsCustomizer({ open, prefs, onChange, onClose }: StatisticsCustomizerProps) {
  const [draft, setDraft] = useState<StatsPreferences>(prefs);
  const [draggingId, setDraggingId] = useState<StatsSectionId | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ id: StatsSectionId; pos: 'before' | 'after' } | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(prefs);
      setDraggingId(null);
      setDropIndicator(null);
    }
  }, [open, prefs]);

  const handleApply = (next: StatsPreferences) => {
    setDraft(next);
    onChange(next);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const itemMap = new Map(STATS_SECTIONS.map((s) => [s.id, s]));
  const isDirty = !isDefaultStatsPreferences(draft);

  const toggleVisible = (id: StatsSectionId) => {
    handleApply({ ...draft, visible: { ...draft.visible, [id]: !draft.visible[id] } });
  };

  const moveSection = (sourceId: StatsSectionId, targetId: StatsSectionId, pos: 'before' | 'after') => {
    if (sourceId === targetId) return;
    const order = draft.order.filter((id) => id !== sourceId);
    const targetIdx = order.indexOf(targetId);
    if (targetIdx === -1) return;
    const insertAt = pos === 'before' ? targetIdx : targetIdx + 1;
    order.splice(insertAt, 0, sourceId);
    handleApply({ ...draft, order });
  };

  const handleReset = () => {
    handleApply(defaultStatsPreferences());
  };

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
            <h3 className="text-lg font-semibold text-gray-900">Statistics dashboard</h3>
            <p className="mt-0.5 text-sm text-gray-500">
              Drag to reorder, eye to hide.
            </p>
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
          {draft.order.map((id) => {
            const meta = itemMap.get(id);
            if (!meta) return null;
            const visible = draft.visible[id];
            const isDragging = draggingId === id;
            const indicator = dropIndicator?.id === id ? dropIndicator.pos : null;
            return (
              <SectionRow
                key={id}
                meta={meta}
                visible={visible}
                isDragging={isDragging}
                dropIndicator={indicator}
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
                  moveSection(sourceId, id, pos);
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

interface SectionRowProps {
  meta: { id: StatsSectionId; label: string; description: string };
  visible: boolean;
  isDragging: boolean;
  dropIndicator: 'before' | 'after' | null;
  onToggle: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverHover: (pos: 'before' | 'after') => void;
  onDragLeave: () => void;
  onDrop: (sourceId: StatsSectionId, pos: 'before' | 'after') => void;
}

function SectionRow({
  meta,
  visible,
  isDragging,
  dropIndicator,
  onToggle,
  onDragStart,
  onDragEnd,
  onDragOverHover,
  onDragLeave,
  onDrop,
}: SectionRowProps) {
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
        e.dataTransfer.setData('text/plain', meta.id);
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
        const sourceId = e.dataTransfer.getData('text/plain') as StatsSectionId;
        if (sourceId && sourceId !== meta.id && dropIndicator) {
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
          {meta.label}
        </div>
        <div className="text-[11px] text-gray-500">{meta.description}</div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded p-1 hover:text-gray-400',
          visible ? 'text-gray-700' : 'text-gray-400'
        )}
        aria-label={visible ? 'Hide section' : 'Show section'}
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
