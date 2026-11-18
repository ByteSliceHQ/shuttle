/**
 * Colours and font for the terminal. xterm draws to a canvas, so it needs real colour values and
 * a real font list: it cannot follow CSS variables the way the rest of the app does. These are
 * read from the app's theme once, when a terminal opens.
 */

/** A CSS colour (any syntax the browser accepts, including `var()` and `oklch()`) as `#rrggbb`. */
export function resolveColor(value: string, fallback: string): string {
  try {
    const probe = document.createElement('span')

    probe.style.color = value
    probe.style.display = 'none'
    document.body.append(probe)

    const computed = getComputedStyle(probe).color

    probe.remove()

    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })

    if (context === null || computed === '') {
      return fallback
    }

    context.fillStyle = computed
    context.fillRect(0, 0, 1, 1)

    const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data

    return `#${[red, green, blue].map((part) => part.toString(16).padStart(2, '0')).join('')}`
  } catch {
    return fallback
  }
}

/** The app's monospace font list, as a value a canvas can use. */
export function terminalFontFamily(): string {
  const declared = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()

  return declared !== '' ? declared : 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
}

/** The terminal's colours: the app's surface and text, and sixteen ANSI colours tuned to sit on it. */
export function terminalTheme() {
  const background = resolveColor('var(--background)', '#101114')
  const foreground = resolveColor('var(--foreground)', '#e9eaee')
  const muted = resolveColor('var(--muted-foreground)', '#9a9ca6')

  return {
    background,
    foreground,
    cursor: resolveColor('var(--brand)', '#6cb0f0'),
    cursorAccent: background,
    selectionBackground: `${resolveColor('var(--brand)', '#6cb0f0')}55`,
    selectionInactiveBackground: `${muted}33`,
    black: resolveColor('var(--secondary)', '#22232a'),
    red: resolveColor('oklch(0.7 0.17 25)', '#f0706a'),
    green: resolveColor('oklch(0.78 0.14 155)', '#62c98b'),
    yellow: resolveColor('oklch(0.82 0.13 85)', '#e0b85c'),
    blue: resolveColor('oklch(0.74 0.13 250)', '#6ca8f0'),
    magenta: resolveColor('oklch(0.74 0.13 310)', '#c58be6'),
    cyan: resolveColor('oklch(0.8 0.1 205)', '#62c6d6'),
    white: resolveColor('oklch(0.86 0.006 265)', '#d2d3d8'),
    brightBlack: muted,
    brightRed: resolveColor('oklch(0.77 0.15 25)', '#ff8f88'),
    brightGreen: resolveColor('oklch(0.85 0.14 155)', '#7fe0a4'),
    brightYellow: resolveColor('oklch(0.88 0.13 90)', '#f0cf7a'),
    brightBlue: resolveColor('oklch(0.81 0.11 250)', '#8fc0ff'),
    brightMagenta: resolveColor('oklch(0.81 0.12 310)', '#d9a6f5'),
    brightCyan: resolveColor('oklch(0.87 0.09 205)', '#86dcea'),
    brightWhite: resolveColor('oklch(0.98 0.003 265)', '#f8f8fa'),
  }
}
