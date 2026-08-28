// Fullscreen, kept inside the pane.
//
// A <webview> guest that enters real fullscreen is pinned to the whole window:
// measured in this app's own Electron build, the guest reports the window's
// dimensions no matter what size its element is, resizing the element while it
// is fullscreen does nothing, and taking the embedder out of fullscreen drags
// the guest out with it. There is no API that confines it. So a video that
// went fullscreen swallowed the entire workspace — every other pane, the rail,
// the dock — which is not what a window on a canvas should be able to do.
//
// This runs inside the page instead and answers the request there: the element
// the site asked to fullscreen is stretched over the guest's own viewport,
// which is exactly the pane's page area, and the page is told it got what it
// asked for. Nothing native is ever entered, so the app window and the macOS
// desktop are never involved.
//
// It is injected with executeJavaScript at dom-ready rather than through a
// preload: the webview is deliberately given no preload path (see the
// will-attach-webview handler in electron/main.js), and this needs none.
export const GUEST_FULLSCREEN_SHIM = `(() => {
  // dom-ready can fire more than once for one document. A second run would
  // capture the first run's wrappers as "the native ones" and wrap them again.
  if (window.__mesaFullscreenShim) return;
  window.__mesaFullscreenShim = true;

  const nativeWebkitRequest = Element.prototype.webkitRequestFullscreen;
  const elementDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreenElement');
  const webkitElementDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'webkitFullscreenElement');

  let active = null;
  let savedCss = '';
  let savedRootCss = '';
  let savedMedia = null;

  // The properties a site is most likely to have set on the element it wants
  // fullscreen, all overridden at the same priority its own stylesheet uses.
  const FILL = {
    position: 'fixed',
    top: '0px',
    right: '0px',
    bottom: '0px',
    left: '0px',
    width: '100%',
    height: '100%',
    'max-width': 'none',
    'max-height': 'none',
    'min-width': '0',
    'min-height': '0',
    margin: '0',
    transform: 'none',
    'z-index': '2147483647',
    'background-color': '#000'
  };

  const enter = (el) => {
    if (active === el) return;
    if (active) restore();
    active = el;
    savedCss = el.style.cssText;
    savedRootCss = document.documentElement.style.cssText;
    for (const [prop, value] of Object.entries(FILL)) el.style.setProperty(prop, value, 'important');
    document.documentElement.style.setProperty('overflow', 'hidden', 'important');

    // A player that sizes its video through :fullscreen rules gets nothing from
    // those rules here, because the document never entered fullscreen. The one
    // element that matters is stretched directly; contain keeps its aspect.
    const media = el.matches('video, img') ? el : el.querySelector('video');
    if (media) {
      savedMedia = { el: media, css: media.style.cssText };
      media.style.setProperty('width', '100%', 'important');
      media.style.setProperty('height', '100%', 'important');
      media.style.setProperty('object-fit', 'contain', 'important');
    }
  };

  const restore = () => {
    if (!active) return null;
    const was = active;
    was.style.cssText = savedCss;
    document.documentElement.style.cssText = savedRootCss;
    if (savedMedia) savedMedia.el.style.cssText = savedMedia.css;
    active = null;
    savedMedia = null;
    return was;
  };

  // fullscreenchange fires at the element and bubbles, which is how a listener
  // on the document hears about it — the same path the real event takes.
  const announce = (el) => {
    for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
      el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    }
  };

  const request = function () {
    enter(this);
    announce(this);
    return Promise.resolve();
  };

  const exit = () => {
    const was = restore();
    if (was) announce(was);
    return Promise.resolve();
  };

  Element.prototype.requestFullscreen = request;
  if (nativeWebkitRequest) Element.prototype.webkitRequestFullscreen = request;
  document.exitFullscreen = exit;
  document.webkitExitFullscreen = exit;

  const define = (name, descriptor) => {
    if (!descriptor || !descriptor.get) return;
    Object.defineProperty(Document.prototype, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      // The captured getter, never document[name] — reading the property from
      // inside its own getter would recurse forever.
      get() {
        return active || descriptor.get.call(this);
      }
    });
  };
  define('fullscreenElement', elementDescriptor);
  define('webkitFullscreenElement', webkitElementDescriptor);

  // Escape leaves fullscreen in every browser, and the browser is not the one
  // handling it here. Capture phase, so a player that swallows the key for its
  // own shortcuts cannot take this one away.
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && active) {
        event.stopPropagation();
        exit();
      }
    },
    true
  );
})();`;
