import { cn } from '@/lib/utils';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useRef } from 'react';

interface ManualScrollbarProps {
  orientation: 'horizontal' | 'vertical';
  value: number;
  viewportSize: number;
  contentSize: number;
  onChange: (nextValue: number) => void;
  className?: string;
}

export function ManualScrollbar({
  orientation,
  value,
  viewportSize,
  contentSize,
  onChange,
  className,
}: ManualScrollbarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);
  const dragOffsetInThumbRef = useRef(0);
  const maxScroll = Math.max(0, contentSize - viewportSize);

  const thumbSizePercent = contentSize > 0
    ? Math.min(100, (viewportSize / contentSize) * 100)
    : 100;
  const thumbTravelPercent = Math.max(0, 100 - thumbSizePercent);
  const thumbOffsetPercent = maxScroll > 0
    ? (value / maxScroll) * thumbTravelPercent
    : 0;

  const handleTrackClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-scrollbar-thumb="true"]')) return;
    if (!trackRef.current || maxScroll <= 0) return;
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = orientation === 'horizontal'
      ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      : Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    onChange(ratio * maxScroll);
  }, [maxScroll, onChange, orientation]);

  const handleThumbMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const thumbRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    isDraggingRef.current = true;
    dragOffsetInThumbRef.current = orientation === 'horizontal'
      ? e.clientX - thumbRect.left
      : e.clientY - thumbRect.top;
  }, [orientation]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !trackRef.current || maxScroll <= 0) return;
      const rect = trackRef.current.getBoundingClientRect();
      const trackSize = orientation === 'horizontal' ? rect.width : rect.height;
      if (trackSize <= 0 || contentSize <= 0) return;

      const thumbSize = trackSize * (viewportSize / contentSize);
      const thumbTravel = trackSize - thumbSize;
      if (thumbTravel <= 0) return;

      const pointer = orientation === 'horizontal'
        ? e.clientX - rect.left
        : e.clientY - rect.top;
      const desiredThumbOffset = pointer - dragOffsetInThumbRef.current;
      const ratio = Math.max(0, Math.min(1, desiredThumbOffset / thumbTravel));
      onChange(ratio * maxScroll);
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [contentSize, maxScroll, onChange, orientation, viewportSize]);

  if (maxScroll <= 0) return null;

  return (
    <div
      ref={trackRef}
      role="scrollbar"
      aria-orientation={orientation}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={maxScroll}
      className={cn(
        'relative overflow-hidden rounded-full bg-gray-200',
        orientation === 'horizontal' ? 'h-2 w-full' : 'h-full w-2',
        className
      )}
      onClick={handleTrackClick}
    >
      <div
        data-scrollbar-thumb="true"
        role="presentation"
        onMouseDown={handleThumbMouseDown}
        className={cn(
          'absolute rounded-full bg-gray-300',
          orientation === 'horizontal' ? 'top-0 h-full min-w-[24px]' : 'left-0 w-full min-h-[24px]'
        )}
        style={
          orientation === 'horizontal'
            ? { width: `${thumbSizePercent}%`, left: `${thumbOffsetPercent}%` }
            : { height: `${thumbSizePercent}%`, top: `${thumbOffsetPercent}%` }
        }
      />
    </div>
  );
}
