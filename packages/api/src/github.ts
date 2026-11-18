import { oc } from '@orpc/contract'
import { z } from 'zod'

import { LinkedRepo } from './workspace'

export const githubContract = {
  /**
   * The repositories the organization's installations can reach, narrowed to those whose name or
   * owner contains `q`. At most fifty are returned.
   */
  repos: oc
    .route({ method: 'GET', path: '/github/repos' })
    .input(z.object({ q: z.string().optional() }))
    .output(z.object({ repos: z.array(LinkedRepo), note: z.string().optional() })),
}
