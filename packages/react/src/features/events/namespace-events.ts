/**
 * Narrows a union of runtime events to the ones one catalog owns (`workspace.*`, `pulls.*`). A projection folds only its
 * own catalog plus a few protocol events, so it narrows to the catalog first and then switches exhaustively.
 */
export function isNamespaceEvent<Event extends { readonly type: string }, Prefix extends string>(
  event: Event,
  prefix: Prefix,
): event is Extract<Event, { readonly type: `${Prefix}.${string}` }> {
  return event.type.startsWith(`${prefix}.`)
}
