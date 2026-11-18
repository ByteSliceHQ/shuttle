import { queryOptions } from '@tanstack/react-query'

import type { ShuttleClient, ShuttleHost } from '../../shuttle'

/** What the backend answers when asked for the playbook. */
export type PlaybookAnswer = Awaited<ReturnType<ShuttleClient['playbook']['get']>>

/**
 * The organization's playbook: its approved lessons, and the ones waiting for review. The
 * playbook is a run of its own, which nothing starts until someone asks for it, so every read
 * makes sure it is started first.
 */
export function playbookQuery({ api, client }: ShuttleHost) {
  // The key's type is given, not inferred: inferred, it carries a tag from the query library
  // that a declaration file cannot name.
  return queryOptions<PlaybookAnswer, Error, PlaybookAnswer>({
    queryKey: api.playbook.get.queryKey(),
    queryFn: async ({ signal }) => {
      await client.playbook.ensure(undefined, { signal })

      return client.playbook.get(undefined, { signal })
    },
  })
}
