/** Share one operation, including its commit; retry only after it settles. */
export class SingleFlight<T> {
  private active: Promise<T> | null = null

  run(operation: () => Promise<T>): Promise<T> {
    if (this.active) return this.active
    const pending = Promise.resolve().then(operation)
    this.active = pending
    const clear = (): void => { if (this.active === pending) this.active = null }
    void pending.then(clear, clear)
    return pending
  }
}
