import { fitName } from './touchBar.mjs';

// One Touch Bar item, drawn: the dock's row, rebuilt for a strip of glass.
//
// A scrubber item is either a line of system-font text or a picture, and a
// picture is sized to itself (electron_touch_bar.mm, sizeForItemAtIndex). So
// the pane is painted whole — mark, three-tone name, brackets — and handed over
// as a PNG. Plain text could say the name, but not which part of it is the
// folder, not whether it is a terminal or a page, and not which one you are in.
//
// Always the dark tokens, whatever the app's theme: the bar is black glass in
// every setting, and the light theme's paper tones would glare on it.

const SCALE = 2; // the Touch Bar is a fixed 2x panel
const HEIGHT = 30; // points; the scrubber's fixed row height

// Gutter baked into every picture, half on each side. The gap between items is
// the scrubber layout's own default, which Electron never sets; carrying the
// space inside the item makes it this app's decision rather than AppKit's.
const GUTTER = 3;
const PAD_LEFT = 10;
const PAD_RIGHT = 11;
const MARK = 13;
const MARK_GAP = 7;
const SEP_GAP = 5;
const MAX_NAME = 176;

// Brackets at the dock cursor's proportions, scaled to a taller row.
const BRACKET_ARM = 6;
const BRACKET_WEIGHT = 1;

const FONT_STACK = '-apple-system, BlinkMacSystemFont, sans-serif';
const FOLDER_FONT = `500 13px ${FONT_STACK}`;
const BRANCH_FONT = `400 13px ${FONT_STACK}`;
const SEP_FONT = `400 11px ${FONT_STACK}`;

// The dock's three steps, each lifted one notch: the rail sits on a lit
// window, the bar on unlit glass read at arm's length, so the dock's own
// resting tones would sink into it.
const TONES = {
  rest: {
    plate: '#1d1a16',
    mark: '#8a847b',
    folder: '#c4beb6',
    sep: '#6b665f',
    branch: '#8a847b'
  },
  focused: {
    plate: '#2a241c',
    mark: '#d9a05c',
    folder: '#f2ede6',
    sep: '#7d776f',
    branch: '#b6b0a8'
  }
};
const BRACKET_COLOR = '#d9a05c';

// Same geometry as PromptMark and PageMark, so the bar and the dock carry one
// pair of marks rather than two that merely resemble each other.
const PROMPT_PATHS = ['M1.5 2.5L5 5.5L1.5 8.5', 'M6 8.5L9.5 8.5'];
const PAGE_PATH =
  'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z';

let canvas = null;
let ctx = null;
function context() {
  if (!ctx) {
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d');
  }
  return ctx;
}

function textWidth(c, font, text) {
  c.font = font;
  return c.measureText(text).width;
}

function nameWidth(c, { folder, branch }) {
  let w = textWidth(c, FOLDER_FONT, folder);
  if (branch) {
    w += SEP_GAP * 2 + textWidth(c, SEP_FONT, '->') + textWidth(c, BRANCH_FONT, branch);
  }
  return w;
}

function drawMark(c, kind, color, x, midY) {
  c.save();
  if (kind === 'browser') {
    // The globe is solid and the prompt is stroked, so at one size the globe
    // lands heavier; trimmed back the way the dock trims it.
    const s = MARK / 24;
    c.translate(x, midY - MARK / 2);
    c.scale(s, s);
    c.globalAlpha = 0.78;
    c.fillStyle = color;
    c.fill(new Path2D(PAGE_PATH));
  } else {
    // An 11-unit glyph centred in the 13-point slot, as the dock centres it.
    c.translate(x + 1, midY - 5.5);
    c.strokeStyle = color;
    c.lineWidth = 1.3;
    c.lineCap = 'square';
    c.lineJoin = 'miter';
    for (const d of PROMPT_PATHS) c.stroke(new Path2D(d));
  }
  c.restore();
}

// Four corners as filled L-shapes rather than stroked lines: filled rectangles
// have no caps to round and no half-pixel to straddle, so they are square and
// crisp by construction.
function drawBrackets(c, x, y, w, h) {
  const a = BRACKET_ARM;
  const t = BRACKET_WEIGHT;
  c.fillStyle = BRACKET_COLOR;
  const right = x + w;
  const bottom = y + h;
  c.fillRect(x, y, a, t);
  c.fillRect(x, y, t, a);
  c.fillRect(right - a, y, a, t);
  c.fillRect(right - t, y, t, a);
  c.fillRect(x, bottom - t, a, t);
  c.fillRect(x, bottom - a, t, a);
  c.fillRect(right - a, bottom - t, a, t);
  c.fillRect(right - t, bottom - a, t, a);
}

function render(item) {
  const c = context();
  const tone = item.focused ? TONES.focused : TONES.rest;
  const name = fitName(item, MAX_NAME, (n) => nameWidth(c, n));

  // Sized from the name at rest and the name focused alike — they share fonts,
  // so the width is the same either way and nothing on the strip moves when
  // the selection does.
  const plateW = Math.ceil(PAD_LEFT + MARK + MARK_GAP + nameWidth(c, name) + PAD_RIGHT);
  const width = plateW + GUTTER * 2;

  canvas.width = width * SCALE;
  canvas.height = HEIGHT * SCALE;
  c.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  c.clearRect(0, 0, width, HEIGHT);

  c.fillStyle = tone.plate;
  c.fillRect(GUTTER, 0, plateW, HEIGHT);
  if (item.focused) drawBrackets(c, GUTTER, 0, plateW, HEIGHT);

  const midY = HEIGHT / 2;
  let x = GUTTER + PAD_LEFT;
  drawMark(c, item.kind, tone.mark, x, midY);
  x += MARK + MARK_GAP;

  // Centred on the capitals, measured rather than assumed, so the name sits on
  // the same axis as the mark beside it. The arrow is smaller type, so it gets
  // its own measurement against the same line.
  c.textBaseline = 'alphabetic';
  c.font = FOLDER_FONT;
  const capHeight = c.measureText('H').actualBoundingBoxAscent;
  // Snapped to the device pixel grid, so the stems land whole rather than
  // smeared across two rows.
  const baseline = Math.round((midY + capHeight / 2) * SCALE) / SCALE;

  c.fillStyle = tone.folder;
  c.fillText(name.folder, x, baseline);
  x += c.measureText(name.folder).width;

  if (name.branch) {
    x += SEP_GAP;
    c.font = SEP_FONT;
    const sep = c.measureText('->');
    // "->" has no capitals; its own ink is centred on the name's midline.
    const sepMid = (sep.actualBoundingBoxAscent - sep.actualBoundingBoxDescent) / 2;
    c.fillStyle = tone.sep;
    c.fillText('->', x, baseline - capHeight / 2 + sepMid);
    x += sep.width + SEP_GAP;

    c.font = BRANCH_FONT;
    c.fillStyle = tone.branch;
    c.fillText(name.branch, x, baseline);
  }

  return canvas.toDataURL('image/png');
}

// Title changes arrive for one pane at a time, and every one of them resends
// the whole strip, so unchanged items are served from here instead of
// repainted. Bounded by clearing outright: a few hundred small PNGs is the
// most this ever holds, and nothing here is expensive to redraw.
const cache = new Map();
const CACHE_LIMIT = 256;

export function drawTouchBarItem(item) {
  // Encoded rather than joined, so a folder with a space in it can never pass
  // for a shorter folder and a longer branch.
  const key = JSON.stringify([item.kind, item.focused, item.folder, item.branch]);
  let url = cache.get(key);
  if (!url) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    url = render(item);
    cache.set(key, url);
  }
  return url;
}
