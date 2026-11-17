import { queryOptions } from '@tanstack/react-query'

import { type ShuttleHost } from '@/shuttle'

/**
 * The organization's playbook: its approved lessons, and the ones waiting for review. The
 * playbook is a run of its own, which nothing starts until someone asks for it, so every read
 * makes sure it is started first.
 */
export function playbookQuery({ api, client }: ShuttleHost) {
  return queryOptions({
    queryKey: api.playbook.get.queryKey(),
    queryFn: async ({ signal }) => {
      await client.playbook.ensure(undefined, { signal })

      return client.playbook.get(undefined, { signal })
    },
  })
}
