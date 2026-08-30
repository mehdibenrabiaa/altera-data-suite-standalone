export const ARTISTIC_PALETTE = [
  { fill: "rgba(99, 102, 241, 0.3)",  stroke: "rgb(99, 102, 241)"  }, // Indigo
  { fill: "rgba(20, 184, 166, 0.3)",  stroke: "rgb(20, 184, 166)"  }, // Teal
  { fill: "rgba(245, 158, 11, 0.3)",  stroke: "rgb(245, 158, 11)"  }, // Amber
  { fill: "rgba(236, 72, 153, 0.3)",  stroke: "rgb(236, 72, 153)"  }, // Pink
  { fill: "rgba(16, 185, 129, 0.3)",  stroke: "rgb(16, 185, 129)"  }, // Emerald
  { fill: "rgba(59, 130, 246, 0.3)",  stroke: "rgb(59, 130, 246)"  }, // Blue
  { fill: "rgba(239, 68, 68, 0.3)",   stroke: "rgb(239, 68, 68)"   }, // Red
  { fill: "rgba(168, 85, 247, 0.3)",  stroke: "rgb(168, 85, 247)"  }, // Violet
  { fill: "rgba(234, 179, 8, 0.3)",   stroke: "rgb(234, 179, 8)"   }, // Yellow
  { fill: "rgba(249, 115, 22, 0.3)",  stroke: "rgb(249, 115, 22)"  }, // Orange
];

export function pickNextColor(usedFills: string[]): { fill: string; stroke: string } {
  const unused = ARTISTIC_PALETTE.filter(c => !usedFills.includes(c.fill));
  const pool = unused.length > 0 ? unused : ARTISTIC_PALETTE;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function fillToHex(fill: string): string {
  const m = fill.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return "#000000";
  return `#${parseInt(m[1]).toString(16).padStart(2,"0")}${parseInt(m[2]).toString(16).padStart(2,"0")}${parseInt(m[3]).toString(16).padStart(2,"0")}`;
}

export function hexToFillStroke(hex: string): { fill: string; stroke: string } {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return { fill: `rgba(${r}, ${g}, ${b}, 0.3)`, stroke: `rgb(${r}, ${g}, ${b})` };
}

export function fillAlpha(fill: string): number {
  const m = fill.match(/rgba?\([^,]+,[^,]+,[^,]+,\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : 1;
}

export function fillWithAlpha(fill: string, alpha: number): string {
  const m = fill.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return fill;
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
}
