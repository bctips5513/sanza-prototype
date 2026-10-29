export interface GestureHandlers {
  onPan?(dx: number, dy: number, x: number, y: number): void;
  onPinch?(scale: number, cx: number, cy: number, dx: number, dy: number): void;
  /** 2本指のひねり [rad]（時計回りが正） */
  onRotate?(dAngle: number): void;
  onTap?(x: number, y: number): void;
  onWheel?(deltaY: number, x: number, y: number, e: WheelEvent): void;
  onEnd?(): void;
}

/** 1本指ドラッグ・2本指ピンチ・タップ・ホイールをまとめて扱う（座標は要素基準の CSS px） */
export function attachGestures(el: HTMLElement, h: GestureHandlers): void {
  const pts = new Map<number, { x: number; y: number }>();
  let downAt = 0;
  let downPos = { x: 0, y: 0 };
  let moved = false;
  let multi = false;

  const local = (e: PointerEvent | WheelEvent) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    const p = local(e);
    pts.set(e.pointerId, p);
    if (pts.size === 1) {
      downAt = performance.now();
      downPos = p;
      moved = false;
      multi = false;
    } else multi = true;
  });

  el.addEventListener('pointermove', (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    if (pts.size === 1) {
      if (Math.hypot(p.x - downPos.x, p.y - downPos.y) > 6) moved = true;
      if (moved && !multi) h.onPan?.(p.x - prev.x, p.y - prev.y, p.x, p.y);
      pts.set(e.pointerId, p);
    } else if (pts.size === 2) {
      const [a, b] = [...pts.entries()];
      const other = a[0] === e.pointerId ? b[1] : a[1];
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
      const d1 = Math.hypot(p.x - other.x, p.y - other.y);
      const c0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
      const c1 = { x: (p.x + other.x) / 2, y: (p.y + other.y) / 2 };
      if (d0 > 0) h.onPinch?.(d1 / d0, c1.x, c1.y, c1.x - c0.x, c1.y - c0.y);
      if (d0 > 20 && d1 > 20 && h.onRotate) {
        let da = Math.atan2(p.y - other.y, p.x - other.x) - Math.atan2(prev.y - other.y, prev.x - other.x);
        if (da > Math.PI) da -= 2 * Math.PI;
        if (da < -Math.PI) da += 2 * Math.PI;
        h.onRotate(da);
      }
      pts.set(e.pointerId, p);
      moved = true;
    }
  });

  const up = (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size === 0) {
      if (!moved && !multi && performance.now() - downAt < 500) h.onTap?.(downPos.x, downPos.y);
      h.onEnd?.();
    }
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      h.onWheel?.(e.deltaY, p.x, p.y, e);
    },
    { passive: false },
  );
}

/** devicePixelRatio を考慮して canvas の大きさを要素に合わせる */
export function fitCanvas(c: HTMLCanvasElement): { w: number; h: number; dpr: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}
