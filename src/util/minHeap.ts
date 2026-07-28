/** An A* open-list entry: f = g + w*h, plus the state signature it keys. */
export interface HeapEntry {
  f: number;
  g: number;
  signature: string;
}

/**
 * Binary min-heap keyed on f.
 *
 * Both TypeScript reference solvers (rolling-blocks and shifting-mosaic) used
 * to carry their own byte-for-byte copy of this; they now share one. It is a
 * plain array heap rather than a sorted structure because the search only ever
 * needs the minimum and pushes far more often than it pops.
 */
export class MinHeap {
  private readonly data: HeapEntry[] = [];

  push(item: HeapEntry) {
    this.data.push(item);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): HeapEntry | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  get size(): number {
    return this.data.length;
  }

  private bubbleUp(i: number) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[parent]!.f <= this.data[i]!.f) break;
      [this.data[parent], this.data[i]] = [this.data[i]!, this.data[parent]!];
      i = parent;
    }
  }

  private sinkDown(i: number) {
    const n = this.data.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.data[l]!.f < this.data[smallest]!.f) smallest = l;
      if (r < n && this.data[r]!.f < this.data[smallest]!.f) smallest = r;
      if (smallest === i) break;
      [this.data[smallest], this.data[i]] = [this.data[i]!, this.data[smallest]!];
      i = smallest;
    }
  }
}
