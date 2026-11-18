// D-20: MC-01..MC-99, wrap after 99, skip values held by live cards.
export class CallsignAllocator {
  private last: number;
  private readonly inUseFn: () => Set<string>;

  constructor(counter: number, inUse: () => Set<string>) {
    this.last = counter;
    this.inUseFn = inUse;
  }

  private static step(n: number): number {
    return n >= 99 ? 1 : n + 1;
  }

  private static format(n: number): string {
    return `MC-${String(n).padStart(2, "0")}`;
  }

  next(): string {
    const used = this.inUseFn();
    const first = CallsignAllocator.step(this.last);
    let candidate = first;
    for (let tries = 0; tries < 99; tries++) {
      if (!used.has(CallsignAllocator.format(candidate))) {
        this.last = candidate;
        return CallsignAllocator.format(candidate);
      }
      candidate = CallsignAllocator.step(candidate);
    }
    // Every value is in use: return the next value anyway.
    this.last = first;
    return CallsignAllocator.format(first);
  }

  counter(): number {
    return this.last;
  }
}
