// lpc_view: display colours for class codes.
//
// This mirrors lpc_view/classes.py. The server's statistics carry the colour of
// every class in the loaded files, from classes.py's table, and the page keeps
// them here (setClassColor); a code the statistics have not named gets the same
// golden-angle hue spread as classes.py's class_color, so the two sides agree on
// every code. Pure: no DOM, so Node can test it.

const CLASS_COLORS = {};

export function setClassColor(code, rgb) { CLASS_COLORS[code] = rgb; }

export function classColor(code) {
  if (CLASS_COLORS[code]) return CLASS_COLORS[code];
  const h = (code * 137.508) % 360;
  const col = hsvToRgb(h / 360, 0.6, 0.85);
  CLASS_COLORS[code] = col;
  return col;
}

export function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
