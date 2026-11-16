import { type BrowserWindow, WebContentsView } from 'electron'

/**
 * What the window shows while Shuttle loads from its deployment: the mark, weaving itself.
 *
 * It is a page of its own laid over the window, because the window's page comes from the
 * network and has nothing to draw until it arrives. It fades away once that page is ready.
 */

/** Long enough that the mark is seen being drawn once rather than flashing by. */
const SHORTEST_MS = 900
const FADE_MS = 260

const PAGE = `<!doctype html>
<meta charset="utf-8">
<style>
  html { background: transparent; }
  body {
    margin: 0;
    height: 100vh;
    display: grid;
    place-items: center;
    background: #0e0e11;
    color: #ededf0;
    font: 13px/1.5 ui-sans-serif, system-ui, sans-serif;
    transition: opacity ${FADE_MS}ms ease;
    -webkit-user-select: none;
    cursor: default;
  }
  body.out { opacity: 0; }
  main { display: grid; justify-items: center; gap: 22px; }
  svg { width: 56px; height: 56px; }
  .warp rect { fill: #ededf0; }
  .weft rect { fill: oklch(0.74 0.13 245); }
  .draw { transform-box: fill-box; animation: lay 2.6s cubic-bezier(0.6, 0, 0.2, 1) infinite; }
  .from-left { transform-origin: left; }
  .from-right { transform-origin: right; animation-delay: 0.22s; }
  @keyframes lay {
    0% { transform: scaleX(0); opacity: 1; }
    38%, 78% { transform: scaleX(1); opacity: 1; }
    100% { transform: scaleX(1); opacity: 0; }
  }
  p { margin: 0; color: #9a9aa6; opacity: 0; animation: late 0.4s ease 5s forwards; }
  @keyframes late { to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    .draw { animation: none; }
  }
</style>
<main>
  <svg viewBox="4 4 40 40" aria-label="Shuttle">
    <defs>
      <clipPath id="over"><rect class="draw from-left" x="5" y="11.500" width="38" height="9" /></clipPath>
      <clipPath id="under"><rect class="draw from-right" x="5" y="27.500" width="38" height="9" /></clipPath>
    </defs>
    <g class="warp">
      <rect x="11.500" y="5" width="9" height="20.500" rx="2.250" />
      <rect x="11.500" y="38.500" width="9" height="4.500" rx="2.250" />
      <rect x="27.500" y="5" width="9" height="4.500" rx="2.250" />
      <rect x="27.500" y="22.500" width="9" height="20.500" rx="2.250" />
    </g>
    <g class="weft" clip-path="url(#over)">
      <rect x="5" y="11.500" width="4.500" height="9" rx="2.250" />
      <rect x="22.500" y="11.500" width="20.500" height="9" rx="2.250" />
    </g>
    <g class="weft" clip-path="url(#under)">
      <rect x="5" y="27.500" width="20.500" height="9" rx="2.250" />
      <rect x="38.500" y="27.500" width="4.500" height="9" rx="2.250" />
    </g>
  </svg>
  <p>Still connecting to Shuttle…</p>
</main>`

/** Lays the splash over a window until the window's own page has loaded, or failed to. */
export function showSplash(window: BrowserWindow): void {
  const view = new WebContentsView()
  const shown = Date.now()

  view.setBackgroundColor('#00000000')

  const fit = () => {
    const [width = 0, height = 0] = window.getContentSize()

    view.setBounds({ x: 0, y: 0, width, height })
  }

  fit()
  window.on('resize', fit)
  window.contentView.addChildView(view)
  void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)

  let leaving = false

  const remove = () => {
    window.removeListener('resize', fit)

    if (!window.isDestroyed()) {
      window.contentView.removeChildView(view)
    }

    view.webContents.close()
  }

  const leave = () => {
    if (leaving) {
      return
    }

    leaving = true

    setTimeout(
      () => {
        if (window.isDestroyed()) {
          remove()

          return
        }

        void view.webContents
          .executeJavaScript(`document.body.classList.add('out')`)
          .catch(() => {})
          .then(() => setTimeout(remove, FADE_MS))
      },
      Math.max(0, SHORTEST_MS - (Date.now() - shown)),
    )
  }

  window.webContents.once('did-finish-load', leave)
  window.webContents.once('did-fail-load', leave)
  window.once('closed', () => (leaving = true))
}
