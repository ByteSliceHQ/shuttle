import { createFileRoute } from '@tanstack/react-router'

import { host } from '@/host'
import { PlaybookPage, playbookQuery } from '@shuttle/react'

export const Route = createFileRoute('/_app/playbook')({
  loader: ({ context: { queryClient } }) =>
    queryClient.query({ ...playbookQuery(host), staleTime: 'static' }),
  component: PlaybookPage,
})
