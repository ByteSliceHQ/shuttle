import { useMutation, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'

import { api } from '@/api/client'

/**
 * What the Worker keeps about one session, as queries. The session page's loader reads the ones
 * it cannot render without; the rest are read by whatever shows them.
 */
export function sessionQueries(id: string) {
  const input = { id }

  return {
    /** Which agent runs the session. */
    harness: api.sessions.harness.get.queryOptions({ input }),
    /** Who Shuttle's conductor may hand work to. */
    team: api.sessions.team.get.queryOptions({ input }),
    /** The model and effort each vendor agent runs on. */
    vendorModels: api.sessions.vendorModels.get.queryOptions({ input }),
    /** Who can open the session. */
    access: api.sessions.access.get.queryOptions({ input }),
    /** Whose sandbox holds the session's files. */
    place: api.sandbox.place.get.queryOptions({ input }),
  }
}

/**
 * Shows a change at once and keeps the page honest about it afterwards. `shown` is written to
 * the query before the Worker answers. What the Worker saved replaces it, unless a later change
 * of the same thing in the same session is still on its way, whose answer is the one that
 * counts. A change the Worker refuses is taken back, and the query is read again in case more
 * than one was. `onRefused` hears of every refusal, not only the last change's.
 */
function optimistic<TData, TInput>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  mutationKey: QueryKey,
  shown: (input: TInput, current: TData | undefined) => TData,
  onRefused?: (cause: Error) => void,
) {
  const read = () => queryClient.getQueryData<TData>(queryKey)
  const write = (data: TData | undefined) => queryClient.setQueryData<TData>(queryKey, data)

  return {
    mutationKey,
    onMutate: async (input: TInput) => {
      // A read still on its way would bring back what the session had before this change.
      await queryClient.cancelQueries({ queryKey })

      const previous = read()

      write(shown(input, previous))

      return { previous }
    },
    onSuccess: (saved: TData) => {
      if (queryClient.isMutating({ mutationKey }) === 1) {
        write(saved)
      }
    },
    onError: (
      cause: Error,
      _input: TInput,
      context: { previous: TData | undefined } | undefined,
    ) => {
      write(context?.previous)

      void queryClient.invalidateQueries({ queryKey })
      onRefused?.(cause)
    },
  }
}

/** Changes which agent runs the session. Applies from the session's next turn. */
export function useSetSessionHarness(runId: string, onRefused?: (cause: Error) => void) {
  const queryClient = useQueryClient()
  const { queryKey } = sessionQueries(runId).harness

  return useMutation(
    api.sessions.harness.set.mutationOptions(
      optimistic(
        queryClient,
        queryKey,
        [...api.sessions.harness.set.mutationKey(), runId],
        ({ harness }) => ({ harness }),
        onRefused,
      ),
    ),
  )
}

/** Changes the session's team. Applies from the conductor's next turn. */
export function useSetSessionTeam(runId: string, onRefused?: (cause: Error) => void) {
  const queryClient = useQueryClient()
  const { queryKey } = sessionQueries(runId).team

  return useMutation(
    api.sessions.team.set.mutationOptions(
      optimistic(
        queryClient,
        queryKey,
        [...api.sessions.team.set.mutationKey(), runId],
        ({ team }) => ({ team }),
        onRefused,
      ),
    ),
  )
}

/** Changes the model or effort one vendor agent runs on. Applies from that agent's next turn. */
export function useSetSessionVendorModel(runId: string, onRefused?: (cause: Error) => void) {
  const queryClient = useQueryClient()
  const { queryKey } = sessionQueries(runId).vendorModels

  return useMutation(
    api.sessions.vendorModels.set.mutationOptions(
      optimistic(
        queryClient,
        queryKey,
        [...api.sessions.vendorModels.set.mutationKey(), runId],
        ({ harness, model, effort }, current) => ({
          choices: {
            ...current?.choices,
            [harness]: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
          },
        }),
        onRefused,
      ),
    ),
  )
}

/**
 * Sets what new sessions start with: the agent, the team, or both. The connections listing
 * carries those defaults, so it is read again afterwards.
 */
export function useSetSessionDefaults(onRefused?: (cause: Error) => void) {
  const queryClient = useQueryClient()

  return useMutation(
    api.connections.setDefault.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: api.connections.list.key() }),
      onError: onRefused,
    }),
  )
}
