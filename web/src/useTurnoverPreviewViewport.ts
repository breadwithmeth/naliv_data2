import { useLayoutEffect, useRef, useState } from "react";
import type { TurnoverPreview } from "./api";

type ContextBoundary = { kind: string; top: number; height: number; label: string };
type StickyContext = { store?: string; group?: string };
type BlockMeasurements = {
  report: TurnoverPreview; showDays: boolean; width: number; heights: ReadonlyMap<number, number>;
};

function contextAt(boundaries: readonly ContextBoundary[], edge: number, kind: "store" | "group") {
  // The original is still the label until it starts passing below the pinned stack.
  let start = 0;
  let end = boundaries.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (boundaries[middle].top < edge) start = middle + 1;
    else end = middle;
  }
  const current = boundaries[start - 1];
  // Leave room for the next original boundary instead of covering it with a stale label.
  return current?.kind === kind && (boundaries[start]?.top ?? Infinity) >= edge + current.height ? current : undefined;
}

export function useTurnoverPreviewViewport({ open, report, expanded, showDays, virtualized }: {
  open: boolean; report: TurnoverPreview; expanded: ReadonlySet<string>; showDays: boolean; virtualized: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const afterCollapse = useRef<HTMLElement | "start" | null>(null);
  const [context, setContext] = useState<StickyContext>({});
  const lastContext = useRef(context);
  const [visibleBlocks, setVisibleBlocks] = useState<ReadonlySet<number>>(() => new Set());
  const [measurements, setMeasurements] = useState<BlockMeasurements>();

  useLayoutEffect(() => {
    viewport.current?.scrollTo(0, 0);
    afterCollapse.current = null;
    setVisibleBlocks((previous) => previous.size ? new Set() : previous);
  }, [report]);

  useLayoutEffect(() => setMeasurements(undefined), [report, showDays]);

  useLayoutEffect(() => {
    const scroll = viewport.current;
    const grid = table.current;
    const head = grid?.tHead;
    if (!open || !scroll || !grid || !head) return;

    const markers = grid.querySelectorAll<HTMLElement>("[data-turnover-boundary]");
    const blocks = new Map<Element, number>();
    if (virtualized) {
      for (const block of grid.querySelectorAll<HTMLTableSectionElement>("[data-turnover-block]")) {
        blocks.set(block, Number(block.dataset.turnoverBlock));
      }
    }
    let all: ContextBoundary[] = [];
    let stores: ContextBoundary[] = [];
    let headHeight = 0;
    let frame: number | null = null;
    let needsMeasure = true;
    let intersections: IntersectionObserver | undefined;
    let margin = 0;

    function watchBlocks(height: number) {
      if (!blocks.size || height <= 0 || height === margin) return;
      margin = height;
      intersections?.disconnect();
      intersections = new IntersectionObserver((entries, observer) => {
        if (observer !== intersections) return;
        setVisibleBlocks((previous) => {
          let next: Set<number> | undefined;
          for (const { target, isIntersecting } of entries) {
            const start = blocks.get(target)!;
            if ((next ?? previous).has(start) === isIntersecting) continue;
            next ??= new Set(previous);
            if (isIntersecting) next.add(start);
            else next.delete(start);
          }
          return next ?? previous;
        });
      }, { root: scroll, rootMargin: `${height}px 0px` });
      for (const block of blocks.keys()) intersections.observe(block);
    }

    const blockStarts = new Set(blocks.values());
    setVisibleBlocks((previous) => {
      let next: Set<number> | undefined;
      for (const start of previous) if (!blockStarts.has(start)) (next ??= new Set(previous)).delete(start);
      return next ?? previous;
    });

    const update = () => {
      frame = null;
      if (!scroll.clientWidth) return;
      if (needsMeasure) {
        needsMeasure = false;
        const origin = scroll.getBoundingClientRect().top + scroll.clientTop - scroll.scrollTop;
        const height = head.getBoundingClientRect().height;
        if (height !== headHeight) {
          headHeight = height;
          scroll.style.setProperty("--turnover-head-height", `${height}px`);
        }
        all = Array.from(markers, (marker) => {
          const rect = marker.getBoundingClientRect();
          return { kind: marker.dataset.turnoverBoundary!, top: rect.top - origin, height: rect.height,
            label: marker.querySelector(".turnover-section-label")?.textContent ?? "" };
        });
        stores = all.filter(({ kind }) => kind === "store" || kind === "overall");
        watchBlocks(scroll.clientHeight);
      }
      const target = afterCollapse.current;
      afterCollapse.current = null;
      if (target === "start") {
        scroll.scrollTop = 0;
      } else if (target?.isConnected) {
        const rect = target.getBoundingClientRect();
        const top = scroll.getBoundingClientRect().top + scroll.clientTop;
        const store = contextAt(stores, scroll.scrollTop + headHeight, "store");
        const topEdge = top + headHeight + (store?.height ?? 0);
        const bottomEdge = top + scroll.clientHeight;
        if (rect.top < topEdge) scroll.scrollTop += rect.top - topEdge;
        else if (rect.bottom > bottomEdge) scroll.scrollTop += Math.min(rect.top - topEdge, rect.bottom - bottomEdge);
      }
      const edge = scroll.scrollTop + headHeight;
      const store = contextAt(stores, edge, "store");
      const group = contextAt(all, edge + (store?.height ?? 0), "group");
      if (store?.label !== lastContext.current.store || group?.label !== lastContext.current.group) {
        lastContext.current = { store: store?.label, group: group?.label };
        setContext(lastContext.current);
      }
    };

    function schedule() {
      frame ??= requestAnimationFrame(update);
    }

    const resize = new ResizeObserver((entries) => {
      const width = scroll.clientWidth;
      if (width) {
        const changed: Array<[number, number]> = [];
        for (const entry of entries) {
          const start = blocks.get(entry.target);
          if (start === undefined || !entry.target.hasAttribute("data-turnover-live")) continue;
          const height = entry.borderBoxSize[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
          if (height > 0) changed.push([start, height]);
        }
        setMeasurements((previous) => {
          const currentLayout = previous?.report === report && previous.showDays === showDays && previous.width === width;
          if (currentLayout && !changed.some(([start, height]) => previous.heights.get(start) !== height)) return previous;
          const heights = new Map(currentLayout ? previous.heights : undefined);
          for (const [start, height] of changed) heights.set(start, height);
          return { report, showDays, width, heights };
        });
      }
      needsMeasure = true;
      schedule();
    });
    resize.observe(scroll);
    resize.observe(grid);
    resize.observe(head);
    for (const marker of markers) resize.observe(marker);
    for (const block of blocks.keys()) resize.observe(block);
    scroll.addEventListener("scroll", schedule, { passive: true });
    schedule(); // The parent may call showModal() after this layout effect.
    return () => {
      resize.disconnect();
      intersections?.disconnect();
      intersections = undefined;
      scroll.removeEventListener("scroll", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [open, report, expanded, showDays, virtualized]);

  return {
    viewport, table, context, afterCollapse, visibleBlocks,
    blockHeights: measurements?.report === report && measurements.showDays === showDays ? measurements.heights : undefined
  };
}
