import { useRouter } from '@tanstack/react-router'
import NProgress from 'nprogress'
import { useEffect } from 'react'

// Starts a little way in so it is visible at once, creeps while the page loads, and has no
// spinner: the bar is the whole indicator. Styled in `styles.css`.
NProgress.configure({ showSpinner: false, trickleSpeed: 200, minimum: 0.1 })

/**
 * The bar across the top of the window during a page change. The page being left stays on
 * screen until the next one has everything it shows, so this is the only sign of the wait, and
 * the reason pages need no loading states of their own.
 *
 * It follows the router's own events: it starts when a change of page begins and finishes when
 * the new page is on screen. A change of search params alone, such as opening an agent's
 * timeline within a session, is not a change of page and does not start it.
 */
export function NavigationProgress() {
  const router = useRouter()

  useEffect(() => {
    const stopStart = router.subscribe('onBeforeLoad', (event) => {
      if (event.pathChanged) {
        NProgress.start()
      }
    })

    const stopDone = router.subscribe('onResolved', () => {
      NProgress.done()
    })

    return () => {
      stopStart()
      stopDone()
      NProgress.done()
    }
  }, [router])

  return null
}
