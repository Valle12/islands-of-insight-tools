// The search's failed-state table: which boards were searched out, in vain,
// at which remaining depth. It replaces a Map<string, number> whose string
// keys measured 284 bytes per entry and grew without bound — the reason the
// hard captured boards died at tens of GB of RSS. Entries here pack four bits
// per cell into a flat Uint32Array, are exact-compared on every hit, and stay
// under a byte budget: the table doubles while it may, and evicts per bucket
// once it has hit the ceiling.
//
// Eviction is SOUND for the proofs the engine makes: an entry only ever
// prevents re-searching a subtree already proven barren at that remaining
// depth, so losing one merely re-searches to the same conclusion, slower.
// What would be unsound is a FALSE hit — which is why keys are compared in
// full, never by hash alone — or recording an aborted subtree, which the
// engine's own store discipline already excludes.

/** Entries per bucket. Four ways ride one cache line for typical key sizes. */
const WAYS = 4;

/** FNV-1a folded over 32-bit words rather than bytes; dispersion is all we need. */
const FNV_BASIS = 0x811c9dc5;
const FNV_PRIME = 16777619;

function largestPowerOfTwo(n: number): number {
  let power = 1;
  while (power * 2 <= n) power *= 2;
  return power;
}

export class TransTable {
  /** Packed words per key: four bits per cell, eight cells per word. */
  private readonly keyWords: number;
  /** Words per entry: [hash, remaining, ...key]. remaining 0 marks an empty slot. */
  private readonly entryWords: number;
  private readonly maxBuckets: number;
  private bucketCount: number;
  private words: Uint32Array;
  /** Pack scratch for the key being probed or stored, plus its hash. */
  private readonly scratch: Uint32Array;
  private scratchHash = 0;
  private entryCount = 0;

  constructor(cellCount: number, maxBytes: number) {
    this.keyWords = Math.max(1, Math.ceil(cellCount / 8));
    this.entryWords = this.keyWords + 2;
    const bucketBytes = WAYS * this.entryWords * 4;
    this.maxBuckets = largestPowerOfTwo(
      Math.max(1, Math.floor(maxBytes / bucketBytes)),
    );
    // Start small and double only when a bucket would otherwise evict: a 3x3
    // board's solve must not pin the budget's worth of memory in its worker.
    this.bucketCount = Math.min(64, this.maxBuckets);
    this.words = new Uint32Array(this.bucketCount * WAYS * this.entryWords);
    this.scratch = new Uint32Array(this.keyWords);
  }

  /** Live entries, for the stats readout. */
  get size(): number {
    return this.entryCount;
  }

  /** True when this exact board is known barren at `remaining` or deeper. */
  probe(cells: Uint8Array, remaining: number): boolean {
    this.packAndHash(cells);
    const at = this.findEntry();
    return at >= 0 && this.words[at + 1]! >= remaining;
  }

  /**
   * Records the board as searched out at `remaining`, which is never 0 — the
   * engine returns before keying a node with no moves left to make. A full
   * bucket doubles the table until the byte budget's bucket ceiling; from
   * there each bucket evicts for itself, so a few entries can go missing
   * while the table as a whole still has room. Losing one only ever costs
   * re-search.
   */
  store(cells: Uint8Array, remaining: number): void {
    this.packAndHash(cells);
    // Growing on overflow is safe exactly because the hash avalanches:
    // colliding keys differ somewhere, so each doubling gets a fresh bit to
    // separate them with. (With the pre-mixer hash, keys could share every
    // low bit forever, and this loop chained to the ceiling.)
    while (!this.insert(remaining)) this.grow();
  }

  /** One insertion attempt at the current size; false asks for a doubling. */
  private insert(remaining: number): boolean {
    const base = this.bucketBase();
    let empty = -1;
    let victim = -1;
    let victimRemaining = Number.POSITIVE_INFINITY;
    for (let way = 0; way < WAYS; way++) {
      const at = base + way * this.entryWords;
      const failedAt = this.words[at + 1]!;
      if (failedAt === 0) {
        if (empty < 0) empty = at;
        continue;
      }
      const storedHash = this.words[at]!;
      if (storedHash === this.scratchHash && this.keyMatches(at + 2)) {
        this.words[at + 1] = remaining;
        return true;
      }
      if (failedAt < victimRemaining) {
        victimRemaining = failedAt;
        victim = at;
      }
    }

    if (empty >= 0) {
      this.writeEntry(empty, remaining);
      this.entryCount++;
      return true;
    }
    if (this.bucketCount < this.maxBuckets) return false;
    // Depth-preferred replacement: an entry that rules out a DEEPER search
    // prunes exponentially more re-work, so the shallowest one in the
    // bucket gives way — and only to an equal or deeper newcomer.
    if (remaining >= victimRemaining) this.writeEntry(victim, remaining);
    return true;
  }

  private bucketBase(): number {
    return (this.scratchHash & (this.bucketCount - 1)) * WAYS * this.entryWords;
  }

  private findEntry(): number {
    const base = this.bucketBase();
    for (let way = 0; way < WAYS; way++) {
      const at = base + way * this.entryWords;
      const failedAt = this.words[at + 1]!;
      if (failedAt === 0) continue;
      const storedHash = this.words[at]!;
      if (storedHash !== this.scratchHash) continue;
      if (this.keyMatches(at + 2)) return at;
    }
    return -1;
  }

  private keyMatches(at: number): boolean {
    for (let word = 0; word < this.keyWords; word++) {
      const stored = this.words[at + word]!;
      const expected = this.scratch[word]!;
      if (stored !== expected) return false;
    }
    return true;
  }

  private writeEntry(at: number, remaining: number): void {
    this.words[at] = this.scratchHash;
    this.words[at + 1] = remaining;
    this.words.set(this.scratch, at + 2);
  }

  private packAndHash(cells: Uint8Array): void {
    const key = this.scratch;
    let hash = FNV_BASIS;
    let word = 0;
    let shift = 0;
    let out = 0;
    for (const cell of cells) {
      word |= cell << shift;
      shift += 4;
      if (shift === 32) {
        key[out++] = word;
        hash = Math.imul(hash ^ word, FNV_PRIME);
        word = 0;
        shift = 0;
      }
    }
    if (shift !== 0) {
      key[out] = word;
      hash = Math.imul(hash ^ word, FNV_PRIME);
    }
    // Finalize with murmur3's mixer. The bucket index is the hash's LOW bits,
    // and a bare multiply's low bits never see the operands' high bits — so
    // without this, boards differing only in high-nibble cells (cells 5..7 of
    // a word group) all landed in one bucket, which chained the growth path
    // to the ceiling and then evicted a near-empty table. Measured, not
    // hypothetical.
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    this.scratchHash = hash >>> 0;
  }

  private grow(): void {
    const old = this.words;
    this.bucketCount *= 2;
    this.words = new Uint32Array(this.bucketCount * WAYS * this.entryWords);
    this.entryCount = 0;
    for (let at = 0; at < old.length; at += this.entryWords) {
      const failedAt = old[at + 1]!;
      if (failedAt !== 0) this.reinsert(old, at);
    }
  }

  private reinsert(old: Uint32Array, from: number): void {
    const hash = old[from]!;
    const base = (hash & (this.bucketCount - 1)) * WAYS * this.entryWords;
    for (let way = 0; way < WAYS; way++) {
      const at = base + way * this.entryWords;
      const occupied = this.words[at + 1]!;
      if (occupied !== 0) continue;
      for (let word = 0; word < this.entryWords; word++) {
        this.words[at + word] = old[from + word]!;
      }
      this.entryCount++;
      return;
    }
    // Unreachable: doubling splits each old bucket across exactly two new
    // ones, so at most WAYS entries can land in either half.
  }
}
