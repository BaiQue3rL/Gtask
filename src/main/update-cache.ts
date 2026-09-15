/** A cooldown cache cannot turn a committed update into a reported failure. */
export function persistUpdateCache<T>(
  state: T,
  write: (state: T) => unknown,
  report: (error: unknown) => void
): T {
  try { write(state) } catch (error) { report(error) }
  return state
}
