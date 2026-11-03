export interface DepthColorStop {
  depth: number;
  color: [number, number, number];
}

export const DEPTH_STOPS: DepthColorStop[] = [
  { depth: 0, color: [66, 176, 255] },
  { depth: 10, color: [56, 166, 255] },
  { depth: 30, color: [33, 244, 210] },
  { depth: 48, color: [137, 255, 177] },
  { depth: 60, color: [255, 140, 77] },
  { depth: 80, color: [255, 84, 60] },
];

export const clampDepth = (depth: number): number =>
  Math.min(80, Math.max(0, Math.abs(depth)));

export const depthColorRgb = (depth: number): [number, number, number] => {
  const value = clampDepth(depth);
  for (let index = 0; index < DEPTH_STOPS.length - 1; index += 1) {
    const current = DEPTH_STOPS[index];
    const next = DEPTH_STOPS[index + 1];
    if (value >= current.depth && value <= next.depth) {
      const t = (value - current.depth) / (next.depth - current.depth);
      return [
        Math.round(current.color[0] + (next.color[0] - current.color[0]) * t),
        Math.round(current.color[1] + (next.color[1] - current.color[1]) * t),
        Math.round(current.color[2] + (next.color[2] - current.color[2]) * t),
      ];
    }
  }
  return value > 60 ? DEPTH_STOPS[DEPTH_STOPS.length - 1].color : DEPTH_STOPS[0].color;
};

export const depthColor = (depth: number): string => {
  const [r, g, b] = depthColorRgb(depth);
  return `rgb(${r} ${g} ${b})`;
};

export const depthColorCss = (depth: number, alpha = 1): string => {
  const [r, g, b] = depthColorRgb(depth);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export const depthBand = (depth: number): 'shallow' | 'mid' | 'deep' => {
  const value = clampDepth(depth);
  if (value < 22) return 'shallow';
  if (value < 46) return 'mid';
  return 'deep';
};
