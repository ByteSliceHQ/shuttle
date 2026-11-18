import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { queryClient, whenSignedOut } from '@/api/query-client'
import { seedRememberedTenant, tenantQuery } from '@/features/auth/tenant'
import { registerServiceWorker } from '@/lib/service-worker'

import { getRouter } from './router'

import './styles.css'

registerServiceWorker()
seedRememberedTenant(queryClient)

// Any request can be the one that finds the sign-in has ended. The app layout sends the person
// to the sign-in page when it sees there is no tenant.
whenSignedOut(() => queryClient.setQueryData(tenantQuery.queryKey, null))

const root = document.getElementById('root')

if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={getRouter()} />
      </QueryClientProvider>
    </StrictMode>,
  )
}
