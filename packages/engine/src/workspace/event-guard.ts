/**
 * Narrows an event to the given types, for a reducer that handles only some of an event union.
 * The listed types are the guard's proof, so a `switch` on the narrowed event is checked against
 * exactly that list.
 */
export function isEventOf<
  Event extends { readonly type: string },
  const Type extends Event['type'],
>(event: Event, types: readonly Type[]): event is Extract<Event, { readonly type: Type }> {
  return types.some((type) => type === event.type)
}
