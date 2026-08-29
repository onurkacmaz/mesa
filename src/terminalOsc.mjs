export const OSC_ST = '\x1b\\';

export const OSC_PALETTE_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
];

// The dark terminal palette. It lives here rather than in theme.js because
// theme.js is a .js file in a CommonJS package and cannot be imported from a
// test; the OSC handlers answer colour probes straight out of this object, so
// it needs to be reachable on its own.
//
// Warm black and amber, the same temperature as the chrome. A tool that builds
// its own UI from the terminal's colour answers (OpenCode does) will therefore
// come out warm here rather than in Warp's cool blue-black.
export const DARK_TERMINAL_THEME = {
  background: '#0b0a09',
  foreground: '#e8e3da',
  cursorAccent: '#0b0a09',
  selectionBackground: 'rgba(217,160,92,0.22)',
  black: '#211f1d',
  red: '#d2705c',
  green: '#93ad6a',
  yellow: '#d9a05c',
  blue: '#7f9cba',
  magenta: '#b98aa8',
  cyan: '#79ada4',
  white: '#d3cdc4',
  brightBlack: '#6d675f',
  brightRed: '#e28c78',
  brightGreen: '#adc487',
  brightYellow: '#eabd7c',
  brightBlue: '#9db8d1',
  brightMagenta: '#d0a6c0',
  brightCyan: '#96c6bd',
  brightWhite: '#f5f1ea'
};

export function hexToOscRgb(hex) {
  const h = hex.replace('#', '');
  const to16 = (i) => {
    const c = parseInt(h.slice(i, i + 2), 16);
    return ((c << 8) | c).toString(16).padStart(4, '0');
  };
  return `rgb:${to16(0)}/${to16(2)}/${to16(4)}`;
}

export function parseOscColor(data) {
  if (!data || data === '?') return null;
  if (data.startsWith('rgb:')) {
    const parts = data.slice(4).split('/');
    if (parts.length < 3) return null;
    const to8 = (p) => (parseInt(p, 16) >> 8) & 0xff;
    const rgb = [to8(parts[0]), to8(parts[1]), to8(parts[2])];
    return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  }
  if (/^#[0-9a-f]{3,8}$/i.test(data)) return data.length === 4 ? null : data.slice(0, 7);
  return null;
}

export function oscPaletteColor(theme, index) {
  const key = OSC_PALETTE_KEYS[Number(index)];
  return key ? theme[key] ?? null : null;
}

// A full-screen TUI used to be forced onto the dark palette whatever the
// chrome was doing. That was aimed at tools which assume a dark terminal, but
// it is far too broad: nano, less and their kin emit no colour of their own,
// they inherit the terminal's — so on the light theme the pane turned into a
// pure black slab with the command text unreadable inside it.
//
// The tools it was meant to protect do not need it. Measured: OpenCode only
// QUERIES colours (OSC 10/11/4 with '?') and paints every cell of its own
// background itself, so it looks the same either way and simply gets an honest
// answer about the surface it is sitting on.
//
// Kept as a function rather than inlined: it is the one place that decides
// which palette a terminal shows, and the OSC handlers have to answer probes
// from the same decision.
export function terminalThemeName(appTheme) {
  return appTheme;
}
