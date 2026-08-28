'use client';

import { getLogs, clearLogs, getAccountsStatus, getBuildInfo } from '@/api';
import { getCurrentAppVersion } from '@/lib/version';
import { ManualScrollbar } from '@/components/ui/ManualScrollbar';
import type { AppOutletContext } from '@/layouts/AppLayout';
import { Check, ChevronDown, ChevronUp, Copy, Download, Minus, Pause, Play, ScrollText, Trash2, WrapText, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import Ansi from 'ansi-to-react';
import stripAnsi from 'strip-ansi';

const POLL_INTERVAL_MS = 2000;
const AT_BOTTOM_THRESHOLD_PX = 80;
const MAX_LOG_LINES = 250;

function tailLines(text: string, maxLines: number): string {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join('\n');
}

function formatUtcNow(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${day} ${h}:${min}:${s} UTC`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function buildDiagnosticsHeader(): Promise<string> {
  const shellVersion = getCurrentAppVersion();
  const info = await getBuildInfo();
  const apiBinaryVer = info?.api_build_ver ?? 'unknown (old binary or unreachable)';
  // mismatch = frontend shell version differs from the native binary's compiled version
  const mismatch =
    info?.api_build_ver != null ? info.api_build_ver !== shellVersion : null;
  const lines = [
    '='.repeat(60),
    '=== IPTRADE DIAGNOSTICS ===',
    '='.repeat(60),
    `Generated:         ${formatUtcNow()}`,
    `App (frontend):    ${shellVersion}`,
    `API binary:        ${apiBinaryVer}`,
    `Build:             ${info?.build ?? 'unknown'}`,
    `Version mismatch:  ${mismatch == null ? 'unknown' : mismatch ? 'YES — native binary is stale, reinstall needed' : 'no'}`,
    '='.repeat(60),
    '',
    '',
  ];
  return lines.join('\n');
}

export function LiveLogsPage() {
  const ctx = useOutletContext<AppOutletContext>();
  const [logContent, setLogContent] = useState<string>('');
  const [isPaused, setIsPaused] = useState(false);
  const [liveTime, setLiveTime] = useState(() => formatUtcNow());
  const [isClearing, setIsClearing] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [wrapLogs, setWrapLogs] = useState(true);
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const [scrollMetrics, setScrollMetrics] = useState<{
    scrollLeft: number;
    clientWidth: number;
    scrollWidth: number;
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
  } | null>(null);

  const checkAtBottom = useCallback((el: HTMLPreElement | null) => {
    if (!el) return false;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD_PX;
  }, []);

  const handleScroll = useCallback(() => {
    setIsAtBottom(checkAtBottom(preRef.current));
  }, [checkAtBottom]);

  const updateScrollState = useCallback(() => {
    const el = preRef.current;
    if (!el) return;
    setScrollMetrics({
      scrollLeft: el.scrollLeft,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    });
  }, []);

  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    updateScrollState();
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    el.addEventListener('scroll', updateScrollState);
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', updateScrollState);
    };
  }, [updateScrollState, logContent]);

  const handleVerticalScrollbarChange = useCallback((nextValue: number) => {
    if (!preRef.current) return;
    preRef.current.scrollTop = nextValue;
  }, []);

  const handleHorizontalScrollbarChange = useCallback((nextValue: number) => {
    if (!preRef.current) return;
    preRef.current.scrollLeft = nextValue;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
      setIsAtBottom(true);
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    const el = preRef.current;
    const atBottom = el
      ? el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD_PX
      : true;
    shouldAutoScrollRef.current = atBottom;
    try {
      const text = await getLogs();
      const normalized = (text != null && text.trim() !== '') ? text : '';
      setLogContent(tailLines(normalized, MAX_LOG_LINES));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load logs');
    }
  }, []);

  useEffect(() => {
    if (shouldAutoScrollRef.current && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
      shouldAutoScrollRef.current = false;
      setIsAtBottom(true);
    }
  }, [logContent]);

  useEffect(() => {
    setLiveTime(formatUtcNow());
    const id = setInterval(() => setLiveTime(formatUtcNow()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (isPaused) return;
    fetchLogs();
    const id = setInterval(fetchLogs, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isPaused, fetchLogs]);

  const handleClear = useCallback(async () => {
    setIsClearing(true);
    setError(null);
    try {
      await clearLogs();
      setLogContent('');
      if (preRef.current) preRef.current.scrollTop = 0;
      setIsAtBottom(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to clear logs');
    } finally {
      setIsClearing(false);
    }
  }, []);

  const handleDownload = useCallback(async () => {
    setIsDownloading(true);
    setError(null);
    try {
      const [logsText, statusPayload, diagnosticsHeader] = await Promise.all([
        getLogs(),
        getAccountsStatus().catch(() => null),
        buildDiagnosticsHeader(),
      ]);
      const logsPart = logsText != null && logsText.trim() !== ''
        ? stripAnsi(logsText).trimEnd()
        : 'Waiting for logs...';
      let finalText = diagnosticsHeader + logsPart;
      if (statusPayload) {
        finalText += `\n\n${'='.repeat(60)}\n=== STATUS / CONFIGURATION (for debugging) ===\n${'='.repeat(60)}\n\n`;
        finalText += JSON.stringify(statusPayload, null, 2);
      } else {
        finalText += '\n\n[Status endpoint could not be fetched - check connectivity]';
      }
      const blob = new Blob([finalText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `IPTRADE_LOGS_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to download');
    } finally {
      setIsDownloading(false);
    }
  }, []);

  const handleCopy = useCallback(async () => {
    const text = stripAnsi((logContent && logContent.trim() !== '') ? logContent : 'Waiting for logs...');
    if (copyFeedbackTimeoutRef.current) clearTimeout(copyFeedbackTimeoutRef.current);
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(true);
      copyFeedbackTimeoutRef.current = setTimeout(() => {
        copyFeedbackTimeoutRef.current = null;
        setCopyFeedback(false);
      }, 2000);
    } catch {
      setCopyFeedback(false);
    }
  }, [logContent]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current) clearTimeout(copyFeedbackTimeoutRef.current);
    };
  }, []);

  const rawText = (logContent && logContent.trim() !== '') ? logContent : 'Waiting for logs...';
  const plainText = useMemo(() => stripAnsi(rawText), [rawText]);
  const { segments, matchCount } = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) {
      return { segments: [] as { type: 'text' | 'match'; value: string; matchIndex?: number }[], matchCount: 0 };
    }
    const regex = new RegExp(escapeRegex(q), 'gi');
    const segs: { type: 'text' | 'match'; value: string; matchIndex?: number }[] = [];
    let lastIndex = 0;
    let matchIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(plainText)) !== null) {
      if (m.index > lastIndex) {
        segs.push({ type: 'text', value: plainText.slice(lastIndex, m.index) });
      }
      segs.push({ type: 'match', value: m[0], matchIndex: matchIndex++ });
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < plainText.length) {
      segs.push({ type: 'text', value: plainText.slice(lastIndex) });
    }
    if (segs.length === 0 && lastIndex === 0) {
      segs.push({ type: 'text', value: plainText });
    }
    return { segments: segs, matchCount: matchIndex };
  }, [plainText, searchQuery]);

  useEffect(() => {
    if (matchCount > 0 && currentMatchIndex >= matchCount) {
      setCurrentMatchIndex(matchCount - 1);
    }
  }, [matchCount, currentMatchIndex]);

  useEffect(() => {
    if (searchQuery.trim()) setCurrentMatchIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (matchCount === 0) return;
    const el = preRef.current?.querySelector(`[data-match-index="${currentMatchIndex}"]`);
    (el as HTMLElement)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [currentMatchIndex, matchCount]);

  const goToPrevMatch = useCallback(() => {
    setCurrentMatchIndex((i) => (matchCount > 0 ? (i - 1 + matchCount) % matchCount : 0));
  }, [matchCount]);

  const goToNextMatch = useCallback(() => {
    setCurrentMatchIndex((i) => (matchCount > 0 ? (i + 1) % matchCount : 0));
  }, [matchCount]);

  return (
    <div className="w-full h-full flex flex-col min-h-0 bg-gray-50 p-4 border-t border-gray-200">
        <section className="flex flex-col gap-2 flex-1 min-h-0">
          <div className="flex items-center justify-between gap-2 flex-wrap flex-shrink-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-gray-900">
                Live logs running <span className="text-gray-500 font-normal text-sm ml-1">{liveTime}</span>
              </h2>
            </div>
            <div className="inline-flex overflow-hidden rounded-lg border border-gray-200 bg-white">
              <button
                type="button"
                className="p-2.5 text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-60 border-r border-gray-200"
                onClick={handleDownload}
                disabled={isDownloading}
                aria-label="Download logs"
              >
                <Download className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="p-2.5 text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-60 border-r border-gray-200"
                onClick={handleCopy}
                aria-label={copyFeedback ? 'Copied' : 'Copy to clipboard'}
              >
                {copyFeedback ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                className="p-2.5 text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-60 border-r border-gray-200"
                onClick={() => setWrapLogs((w) => !w)}
                aria-label={wrapLogs ? 'Single line (no wrap)' : 'Wrap text'}
              >
                {wrapLogs ? (
                  <WrapText className="h-4 w-4" />
                ) : (
                  <Minus className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                className="p-2.5 text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:pointer-events-none border-r border-gray-200"
                onClick={scrollToBottom}
                disabled={isAtBottom}
                aria-label="Go to latest"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="p-2.5 text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-60 border-r border-gray-200"
                onClick={() => setIsPaused((p) => !p)}
                aria-label={isPaused ? 'Resume' : 'Pause'}
              >
                {isPaused ? (
                  <Play className="h-4 w-4" />
                ) : (
                  <Pause className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                className="p-2.5 text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-60"
                onClick={handleClear}
                disabled={isClearing}
                aria-label="Clear logs"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
          {error && (
            <p className="text-sm text-red-600 flex-shrink-0">{error}</p>
          )}
          <div className="flex items-center flex-shrink-0">
            <div className="flex w-full overflow-hidden rounded-lg border border-gray-200 bg-white">
              <input
                type="text"
                placeholder="Search in logs..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && searchQuery.trim() && matchCount > 0) {
                    e.preventDefault();
                    goToNextMatch();
                  }
                }}
                className="min-w-0 flex-1 border-0 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:outline-none focus-visible:outline-none ring-0 focus:ring-0 focus-visible:ring-0"
                aria-label="Search in logs"
              />
              <button
                type="button"
                className="p-2.5 text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:pointer-events-none border-l border-gray-200"
                onClick={goToPrevMatch}
                disabled={!searchQuery.trim() || matchCount === 0}
                aria-label="Previous match"
              >
                <ChevronUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="p-2.5 text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:pointer-events-none border-l border-gray-200"
                onClick={goToNextMatch}
                disabled={!searchQuery.trim() || matchCount === 0}
                aria-label="Next match"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
              <div
                className="min-w-[4rem] border-l border-gray-200 px-3 py-2 text-sm text-gray-700 text-center tabular-nums"
                aria-live="polite"
              >
                {searchQuery.trim() ? `${matchCount > 0 ? currentMatchIndex + 1 : 0}/${matchCount}` : '0/0'}
              </div>
              <button
                type="button"
                className="p-2.5 text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:pointer-events-none border-l border-gray-200"
                onClick={() => setSearchQuery('')}
                disabled={!searchQuery.trim()}
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="flex flex-col flex-1 min-h-0 rounded-lg border border-gray-200 overflow-hidden bg-white relative">
            <div
              className="absolute inset-0 flex items-center justify-center pointer-events-none select-none z-0"
              aria-hidden="true"
            >
              <div className="flex flex-col gap-0 leading-none">
                <span className="text-4xl text-gray-200 p-0 m-0 leading-none">瞬写</span>
                <span className="text-5xl font-bold text-gray-200 p-0 m-0 leading-none">IPTRADE</span>
              </div>
            </div>
            <div className="flex flex-1 min-h-0 overflow-hidden relative z-10">
              <pre
                ref={preRef}
                onScroll={handleScroll}
                className={`flex-1 min-h-0 min-w-0 select-text selection:bg-blue-600 selection:text-white text-gray-900 p-2 text-xs font-mono [&_code]:bg-transparent [&_code]:p-0 [&_code]:font-inherit ${
                  wrapLogs
                    ? 'overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-all'
                    : 'overflow-auto whitespace-pre'
                }`}
              >
                {!searchQuery.trim() ? (
                  <Ansi>{rawText}</Ansi>
                ) : (
                  segments.map((seg, i) =>
                    seg.type === 'text' ? (
                      <span key={i}>{seg.value}</span>
                    ) : (
                      <span
                        key={i}
                        className={`text-gray-900 ${
                          seg.matchIndex === currentMatchIndex
                            ? 'bg-amber-200 ring-1 ring-amber-400'
                            : 'bg-yellow-400/80'
                        }`}
                        data-match-index={seg.matchIndex}
                      >
                        {seg.value}
                      </span>
                    )
                  )
                )}
              </pre>
              {scrollMetrics && scrollMetrics.scrollHeight > scrollMetrics.clientHeight && (
                <div className="flex flex-col px-2 py-2 bg-white border-l border-gray-200 shrink-0 self-stretch">
                  <ManualScrollbar
                    orientation="vertical"
                    value={scrollMetrics.scrollTop}
                    viewportSize={scrollMetrics.clientHeight}
                    contentSize={scrollMetrics.scrollHeight}
                    onChange={handleVerticalScrollbarChange}
                    className="flex-1 min-h-0"
                  />
                </div>
              )}
            </div>
            {!wrapLogs && scrollMetrics && scrollMetrics.scrollWidth > scrollMetrics.clientWidth && (
              <div className="flex items-center px-2 py-2 bg-white border-t border-gray-200 shrink-0">
                <ManualScrollbar
                  orientation="horizontal"
                  value={scrollMetrics.scrollLeft}
                  viewportSize={scrollMetrics.clientWidth}
                  contentSize={scrollMetrics.scrollWidth}
                  onChange={handleHorizontalScrollbarChange}
                  className="flex-1"
                />
              </div>
            )}
          </div>
        </section>
    </div>
  );
}
