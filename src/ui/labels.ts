export interface LabelItem {
  id: number;
  x: number;
  y: number;
  /** 2行表示：山名 / 標高・距離 */
  title: string;
  sub: string;
  priority: number;
  named: boolean;
  marginal: boolean;
}

export interface PlacedLabel extends LabelItem {
  row: number;
  w: number;
}

/** 高優先度から順に、重ならない最上段の行へ配置する */
export function layoutLabels(
  ctx: CanvasRenderingContext2D,
  items: LabelItem[],
  maxRows: number,
  titleFont: string,
  subFont: string,
): PlacedLabel[] {
  const rows: [number, number][][] = Array.from({ length: maxRows }, () => []);
  const placed: PlacedLabel[] = [];
  const sorted = [...items].filter((i) => i.named).sort((a, b) => b.priority - a.priority);
  for (const it of sorted) {
    ctx.font = titleFont;
    const w1 = ctx.measureText(it.title).width;
    ctx.font = subFont;
    const w2 = ctx.measureText(it.sub).width;
    const w = Math.max(w1, w2) + 8;
    const x0 = it.x - 3;
    const x1 = it.x + w;
    for (let r = 0; r < maxRows; r++) {
      if (rows[r].every(([a, b]) => x1 < a || x0 > b)) {
        rows[r].push([x0, x1]);
        placed.push({ ...it, row: r, w });
        break;
      }
    }
  }
  return placed;
}

/** 引き出し線付きの山名ラベルと山頂マーカーを描く */
export function drawLabels(
  ctx: CanvasRenderingContext2D,
  items: LabelItem[],
  placed: PlacedLabel[],
  top: number,
  rowH: number,
  opts: { titleFont: string; subFont: string; color: string; halo: string; selected?: number | null },
): void {
  // マーカー（名前なしは小さな点）
  for (const it of items) {
    ctx.beginPath();
    if (it.named) {
      ctx.moveTo(it.x, it.y - 1);
      ctx.lineTo(it.x - 5, it.y - 10);
      ctx.lineTo(it.x + 5, it.y - 10);
      ctx.closePath();
      ctx.fillStyle = it.marginal ? 'rgba(255,200,0,0.6)' : '#ffcc00';
    } else {
      ctx.arc(it.x, it.y - 3, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = it.marginal ? 'rgba(0,229,255,0.5)' : '#00e5ff';
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (opts.selected === it.id) {
      ctx.beginPath();
      ctx.arc(it.x, it.y - 5, 10, 0, Math.PI * 2);
      ctx.strokeStyle = '#ff3b30';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  for (const p of placed) {
    const ly = top + p.row * rowH;
    ctx.beginPath();
    ctx.moveTo(p.x, ly + rowH - 4);
    ctx.lineTo(p.x, p.y - 11);
    ctx.strokeStyle = p.marginal ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    for (const [text, font, dy] of [
      [p.title, opts.titleFont, 0],
      [p.sub, opts.subFont, rowH * 0.5],
    ] as const) {
      ctx.font = font;
      ctx.strokeStyle = opts.halo;
      ctx.lineWidth = 3;
      ctx.strokeText(text, p.x + 3, ly + dy);
      ctx.fillStyle = p.marginal ? 'rgba(255,255,255,0.65)' : opts.color;
      ctx.fillText(text, p.x + 3, ly + dy);
    }
  }
}

/** 距離帯ごとの色（近い = 濃い、遠い = 淡い） */
export function bandFill(b: number, n: number): string {
  const t = n <= 1 ? 1 : b / (n - 1); // 0 = 近, 1 = 遠
  const l = 18 + t * 52;
  const s = 18 + t * 12;
  return `hsl(215 ${s}% ${l}%)`;
}

export function bandLine(b: number, n: number): string {
  const t = n <= 1 ? 1 : b / (n - 1);
  // 写真上で見やすいよう、近=橙 → 遠=水色
  const hue = 25 + t * 165;
  return `hsl(${hue} 100% 60%)`;
}
