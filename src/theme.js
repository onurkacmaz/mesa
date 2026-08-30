import { DARK_TERMINAL_THEME } from './terminalOsc.mjs';

// Both themes are warm-neutral and amber-forward: the light one is not a
// simple inversion but its own surface — paper under lamplight rather than a
// blank white sheet — so the workspace keeps one temperature either way.
//
// The dark terminal palette itself sits in terminalOsc.mjs, because the OSC
// handlers answer colour probes out of it and it has to be importable from a
// test. A tool that dresses itself from those answers (OpenCode does) picks up
// this warmth rather than borrowing another terminal's.

// One accent for the whole app. Giving every terminal its own tint turned the
// canvas into a colour chart and made the borders read as status rather than
// as chrome; a single amber, shifted per theme to stay legible against the
// surface it sits on, keeps every pane part of the same object.
export const ACCENT = { dark: '#d9a05c', light: '#9a6a1f' };

export const SELECTION_COLOR = { dark: '#c9a35f', light: '#9a6a1f' };

export const DANGER = { dark: '#d2705c', light: '#a2402c' };

// The row a command was typed on gets a lit background. xterm only accepts
// #RRGGBB here, so these are solid values a step off each theme's screen.
export const COMMAND_ROW_BG = { dark: '#1b1712', light: '#f3f0ea' };

export const COMMAND_RULE = {
  dark: 'rgba(255,255,255,0.10)',
  light: 'rgba(0,0,0,0.14)'
};

export const TERMINAL_THEMES = {
  dark: {
    ...DARK_TERMINAL_THEME
  },
  light: {
    background: '#ffffff',
    foreground: '#2b2723',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(154,106,31,0.20)',
    black: '#2b2723',
    red: '#a2402c',
    green: '#4d6a2e',
    yellow: '#8a6520',
    blue: '#35597f',
    magenta: '#7b4a6b',
    cyan: '#2f6b62',
    white: '#6b645c',
    brightBlack: '#8b837a',
    brightRed: '#bd5138',
    brightGreen: '#5f7f39',
    brightYellow: '#a17a29',
    brightBlue: '#436b96',
    brightMagenta: '#8f5a7c',
    brightCyan: '#3a8076',
    brightWhite: '#4a443d'
  }
};

const STORAGE_KEY = 'wfterm.theme';

// Three states, because "follow the system" is a real preference and not the
// same as picking a side.
export const THEME_MODES = ['auto', 'light', 'dark'];

export function readStoredMode() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return THEME_MODES.includes(stored) ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

export function storeMode(mode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Private window or blocked storage: the choice just won't persist.
  }
}

export function systemTheme() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}
