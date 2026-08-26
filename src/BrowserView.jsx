import React, { useCallback, useEffect, useRef, useState } from 'react';

// Bir browser panesinin tamamı: Chromium'un araç çubuğu + sayfanın oturduğu
// ekran. Bu şerit bilinçli olarak uygulamanın kendi kare dilinin dışındadır:
// Chrome neyse o — hap biçimli omnibox, dairesel hover hedefleri, Material
// ikonlar, Chrome'un gri paleti ve sekmedeki dönen yükleme işareti.

export const BROWSER_HOME = 'https://en.wikipedia.org/wiki/Terminal_emulator';

// Electron, varsayılan User-Agent'ın sonuna uygulamanın adını ve
// "Electron/32.x" jetonunu ekler. Bazı siteler — YouTube en bilineni — UA'yı
// tanımadığında sayfayı bozuk bir yoldan kurar: metin ve resimler gelir ama
// ikon bileşenleri boş kalır. Buradaki tek iş o iki jetonu düşürüp geriye
// kalan gerçek Chrome dizesini guest'e vermek; sürüm sabitlenmiyor, çalışan
// Chromium'un kendi sürümü kullanılıyor.
const CHROME_UA = navigator.userAgent
  .replace(/\sElectron\/\S+/, '')
  .replace(/\s\S+\/\S+(?=\sChrome\/)/, '');

// Chrome'un kendi yakınlaştırma basamakları.
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

// Omnibox bir arama kutusu da: nokta içermeyen bir girdi host değil, sorgudur.
function normalizeInput(raw) {
  const s = raw.trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(s)) return `http://${s}`;
  if (!/^[^\s/?#]+\.[^\s/?#]{2,}/.test(s)) {
    return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
  }
  return `https://${s}`;
}

// Chrome gibi: https gizlenir, host tam tonda okunur, yolun geri kalanı söner.
// Bir input'un metninin parçalarını boyayamazsınız — bu yüzden dinlenme hâli
// bir düğme, yazma hâli bir input.
function splitUrl(url) {
  try {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const insecure = u.protocol === 'http:';
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`;
    if (!u.host) {
      return { secure: false, insecure: false, prefix: u.protocol, host: rest || u.href, rest: '' };
    }
    return { secure, insecure, prefix: secure ? '' : `${u.protocol}//`, host: u.host, rest };
  } catch {
    return { secure: false, insecure: false, prefix: '', host: url, rest: '' };
  }
}

/* ── İkonlar ───────────────────────────────────────────────────────────────
   Chrome'un kullandığı Material glifleri, 24'lük ızgarada dolu yollar olarak,
   16px'e indirilmiş. Uygulamanın geri kalanındaki çizili kare ikonlar burada
   geçerli değil: bu şerit birebir Chromium olsun diye isteniyor. */
const icon = (path) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d={path} />
  </svg>
);

const IconBack = () => icon('M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z');
const IconForward = () => icon('M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z');
const IconRefresh = () =>
  icon(
    'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z'
  );
const IconStop = () =>
  icon('M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z');
const IconMore = () =>
  icon(
    'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z'
  );

const IconLock = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z" />
  </svg>
);

const IconInfo = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" />
  </svg>
);

const IconSearch = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
  </svg>
);

// Faviconu olmayan sayfa için Chrome'un koyduğu şey bir küre.
export function PageMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
    </svg>
  );
}

// Chrome'un sekmesindeki dönen yükleme işareti: sayfa yüklenirken favicon'un
// yerini alır. Hareketi hak ediyor, çünkü gerçekten değişen bir durumu
// gösteriyor — ve azaltılmış hareket tercihinde dönmeden, sabit durur.
export function Throbber() {
  return (
    <svg className="cr-throbber" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.22" />
      <path
        d="M12 3a9 9 0 0 1 9 9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function BrowserView({ paneId, focused, onStatus }) {
  const hostRef = useRef(null);
  const readyRef = useRef(false);
  const inputRef = useRef(null);
  const menuRef = useRef(null);

  const [url, setUrl] = useState(BROWSER_HOME);
  const [draft, setDraft] = useState(BROWSER_HOME);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [error, setError] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [zoom, setZoom] = useState(1);

  // webview metotları dom-ready'den önce fırlatır; her çağrı bu kapıdan geçer.
  const guest = () => (readyRef.current ? hostRef.current : null);

  const syncNav = useCallback(() => {
    const w = guest();
    if (!w) return;
    try {
      setCanBack(w.canGoBack());
      setCanForward(w.canGoForward());
    } catch {
      // Guest yeniden bağlanırken kısa bir an sorulamaz olur; bir sonraki
      // navigasyon olayı zaten tekrar soracak.
    }
  }, []);

  useEffect(() => {
    const w = hostRef.current;
    if (!w) return undefined;

    const onDomReady = () => {
      readyRef.current = true;
      syncNav();
    };
    const onStart = () => {
      setLoading(true);
      setError(null);
    };
    const onStop = () => {
      setLoading(false);
      syncNav();
    };
    const onNavigate = (e) => {
      if (e.url) {
        setUrl(e.url);
        setEditing(false);
        setDraft(e.url);
      }
      setError(null);
      syncNav();
    };
    const onNavigateInPage = (e) => {
      if (e.isMainFrame && e.url) {
        setUrl(e.url);
        setDraft(e.url);
      }
      syncNav();
    };
    const onTitle = (e) => onStatus?.(paneId, { pageTitle: e.title });
    const onFavicon = (e) => onStatus?.(paneId, { favicon: e.favicons?.[0] ?? null });
    const onFail = (e) => {
      // -3 (ABORTED) sıradan bir iptaldir: bir yükleme biterken yeni bir
      // adrese gidilmiştir. Hata ekranı göstermek yanlış olurdu.
      if (!e.isMainFrame || e.errorCode === -3) return;
      setError({ code: e.errorCode, description: e.errorDescription, url: e.validatedURL });
      setLoading(false);
    };

    w.addEventListener('dom-ready', onDomReady);
    w.addEventListener('did-start-loading', onStart);
    w.addEventListener('did-stop-loading', onStop);
    w.addEventListener('did-navigate', onNavigate);
    w.addEventListener('did-navigate-in-page', onNavigateInPage);
    w.addEventListener('page-title-updated', onTitle);
    w.addEventListener('page-favicon-updated', onFavicon);
    w.addEventListener('did-fail-load', onFail);
    return () => {
      w.removeEventListener('dom-ready', onDomReady);
      w.removeEventListener('did-start-loading', onStart);
      w.removeEventListener('did-stop-loading', onStop);
      w.removeEventListener('did-navigate', onNavigate);
      w.removeEventListener('did-navigate-in-page', onNavigateInPage);
      w.removeEventListener('page-title-updated', onTitle);
      w.removeEventListener('page-favicon-updated', onFavicon);
      w.removeEventListener('did-fail-load', onFail);
    };
  }, [paneId, onStatus, syncNav]);

  // Sekmedeki throbber pane başlığında yaşıyor, o yüzden yükleme durumu
  // yukarı bildiriliyor.
  useEffect(() => {
    onStatus?.(paneId, { loading });
  }, [loading, paneId, onStatus]);

  const navigate = useCallback((raw) => {
    const next = normalizeInput(raw);
    const w = guest();
    if (!next || !w) return;
    setEditing(false);
    w.loadURL(next).catch(() => {
      // Yükleme hatası zaten did-fail-load'dan geliyor; burada yutmak
      // yakalanmamış bir promise reddi bırakmamak içindir.
    });
  }, []);

  const beginEditing = useCallback(() => {
    setDraft(url);
    setEditing(true);
  }, [url]);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  // ⌘L omnibox'a gider. Odak sayfanın içindeyken tuşlar ayrı bir WebContents'e
  // gider ve buraya hiç ulaşmaz — bu kısayol pane chrome'u odaktayken çalışır.
  useEffect(() => {
    if (!focused) return undefined;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        beginEditing();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, beginEditing]);

  // Menü dışarı tıklamayla ve Escape ile kapanır — Chrome'un yaptığı gibi.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e) => {
      if (!menuRef.current?.contains(e.target)) setMenuOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const applyZoom = (direction) => {
    const w = guest();
    if (!w) return;
    const index = ZOOM_STEPS.indexOf(zoom);
    const base = index === -1 ? ZOOM_STEPS.indexOf(1) : index;
    const next =
      direction === 0 ? 1 : ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, base + direction))];
    w.setZoomFactor(next);
    setZoom(next);
  };

  const parts = splitUrl(url);

  return (
    <>
      <div className="cr-toolbar">
        <button
          type="button"
          className="cr-btn"
          disabled={!canBack}
          onClick={() => guest()?.goBack()}
          title="Geri git"
          aria-label="Geri git"
        >
          <IconBack />
        </button>
        <button
          type="button"
          className="cr-btn"
          disabled={!canForward}
          onClick={() => guest()?.goForward()}
          title="İleri git"
          aria-label="İleri git"
        >
          <IconForward />
        </button>
        <button
          type="button"
          className="cr-btn"
          onClick={() => (loading ? guest()?.stop() : guest()?.reload())}
          title={loading ? 'Yüklemeyi durdur' : 'Bu sayfayı yeniden yükle'}
          aria-label={loading ? 'Yüklemeyi durdur' : 'Bu sayfayı yeniden yükle'}
        >
          {loading ? <IconStop /> : <IconRefresh />}
        </button>

        {editing ? (
          <div className="cr-omnibox cr-omnibox-active">
            <span className="cr-omnibox-icon">
              <IconSearch />
            </span>
            <input
              ref={inputRef}
              className="cr-omnibox-input"
              value={draft}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setEditing(false)}
              onKeyDown={(e) => {
                // Tuşlar tuvale sızmamalı: ⌘B burada yeni bir pane açamaz.
                e.stopPropagation();
                if (e.key === 'Enter') navigate(draft);
                if (e.key === 'Escape') {
                  setDraft(url);
                  setEditing(false);
                }
              }}
            />
          </div>
        ) : (
          <button type="button" className="cr-omnibox" onClick={beginEditing} title={url}>
            <span className={`cr-omnibox-icon${parts.insecure ? ' cr-omnibox-icon-warn' : ''}`}>
              {parts.insecure ? <IconInfo /> : parts.secure ? <IconLock /> : <IconInfo />}
            </span>
            {parts.insecure && <span className="cr-notsecure">Güvenli değil</span>}
            <span className="cr-url">
              {parts.prefix && !parts.insecure && <span className="cr-url-dim">{parts.prefix}</span>}
              <span className="cr-url-host">{parts.host}</span>
              {parts.rest && <span className="cr-url-dim">{parts.rest}</span>}
            </span>
          </button>
        )}

        <div className="cr-menu-anchor" ref={menuRef}>
          <button
            type="button"
            className={`cr-btn${menuOpen ? ' cr-btn-open' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            title="Özelleştir ve denetle"
            aria-label="Özelleştir ve denetle"
            aria-expanded={menuOpen}
          >
            <IconMore />
          </button>

          {menuOpen && (
            <div className="cr-menu" role="menu">
              <div className="cr-menu-zoom">
                <span className="cr-menu-zoom-label">Yakınlaştır</span>
                <button
                  type="button"
                  className="cr-zoom-btn"
                  onClick={() => applyZoom(-1)}
                  title="Uzaklaştır"
                  aria-label="Uzaklaştır"
                >
                  −
                </button>
                <span className="cr-menu-zoom-value">{Math.round(zoom * 100)}%</span>
                <button
                  type="button"
                  className="cr-zoom-btn"
                  onClick={() => applyZoom(1)}
                  title="Yakınlaştır"
                  aria-label="Yakınlaştır"
                >
                  +
                </button>
                <button type="button" className="cr-zoom-reset" onClick={() => applyZoom(0)}>
                  Sıfırla
                </button>
              </div>
              <div className="cr-menu-sep" />
              <button
                type="button"
                className="cr-menu-item"
                role="menuitem"
                onClick={() => {
                  guest()?.reload();
                  setMenuOpen(false);
                }}
              >
                Yeniden yükle
              </button>
              <button
                type="button"
                className="cr-menu-item"
                role="menuitem"
                onClick={() => {
                  navigator.clipboard?.writeText(url);
                  setMenuOpen(false);
                }}
              >
                Bağlantıyı kopyala
              </button>
              <div className="cr-menu-sep" />
              <button
                type="button"
                className="cr-menu-item"
                role="menuitem"
                onClick={() => {
                  const w = guest();
                  if (w) (w.isDevToolsOpened() ? w.closeDevTools() : w.openDevTools());
                  setMenuOpen(false);
                }}
              >
                Geliştirici araçları
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="pane-screen browser-screen">
        <webview ref={hostRef} src={BROWSER_HOME} useragent={CHROME_UA} className="browser-webview" />
        {/* Menü açıkken sayfaya yapılan tıklama host belgesine hiç ulaşmaz —
            guest ayrı bir WebContents. Sayfanın üzerindeki bu şeffaf katman
            o tıklamayı yakalar ve menüyü Chrome'daki gibi kapatır. */}
        {menuOpen && <div className="cr-scrim" onMouseDown={() => setMenuOpen(false)} />}
        {error && (
          <div className="cr-error">
            <PageMark />
            <p className="cr-error-title">Bu siteye ulaşılamıyor</p>
            <p className="cr-error-detail">
              {error.description || 'Bilinmeyen hata'} ({error.code})
            </p>
            <button type="button" className="cr-error-retry" onClick={() => navigate(error.url || url)}>
              Yeniden yükle
            </button>
          </div>
        )}
      </div>
    </>
  );
}
