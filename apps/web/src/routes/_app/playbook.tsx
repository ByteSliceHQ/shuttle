import { createFileRoute } from '@tanstack/react-router'

import { PlaybookPage } from '@/features/playbook/playbook-page'
import { playbookQuery } from '@/features/playbook/playbook-query'

export const Route = createFileRoute('/_app/playbook')({
  loader: ({ context: { queryClient } }) =>
    queryClient.query({ ...playbookQuery, staleTime: 'static' }),
  component: PlaybookPage,
})
