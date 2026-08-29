import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OSC_PALETTE_KEYS,
  DARK_TERMINAL_THEME,
  hexToOscRgb,
  oscPaletteColor,
  parseOscColor,
  terminalThemeName
} from '../src/terminalOsc.mjs';

test('formats 8-bit hex colors as 16-bit OSC rgb payloads', () => {
  assert.equal(hexToOscRgb('#0b0a09'), 'rgb:0b0b/0a0a/0909');
});

test('parses OSC rgb payloads back into 8-bit hex colors', () => {
  assert.equal(parseOscColor('rgb:0b0b/0a0a/0909'), '#0b0a09');
});

// The palette a colour probe is answered with is the app's own warm black, not
// another terminal's. A tool that builds its UI from these answers follows the
// chrome's temperature, which is the whole reason the probe is answered at all.
test('answers colour probes with the app\'s warm dark palette', () => {
  assert.equal(DARK_TERMINAL_THEME.background, '#0b0a09');
  assert.equal(DARK_TERMINAL_THEME.selectionBackground, 'rgba(217,160,92,0.22)');
});

test('maps OSC 4 palette indexes to xterm theme color keys', () => {
  assert.equal(OSC_PALETTE_KEYS[4], 'blue');
  assert.equal(OSC_PALETTE_KEYS[12], 'brightBlue');
  assert.equal(oscPaletteColor(DARK_TERMINAL_THEME, '4'), '#7f9cba');
  assert.equal(oscPaletteColor(DARK_TERMINAL_THEME, '12'), '#9db8d1');
  assert.equal(oscPaletteColor(DARK_TERMINAL_THEME, '255'), null);
});

// A TUI follows the chrome rather than being forced dark: nano and less paint
// no background of their own, so forcing dark turned a light-theme pane into a
// black slab.
test('a terminal follows the app theme, alternate screen or not', () => {
  assert.equal(terminalThemeName('light'), 'light');
  assert.equal(terminalThemeName('dark'), 'dark');
});
