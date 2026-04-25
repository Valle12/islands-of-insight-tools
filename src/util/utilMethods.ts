export function mod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

export function gcd(a: number, b: number): number {
  if (b === 0) return a;
  return gcd(b, a % b);
}

export function lcm(values: number[]): number {
  return values.reduce((acc, val) => (acc * val) / gcd(acc, val), 1);
}

export function* cartesianProduct(limits: number[]): Generator<number[]> {
  const numButtons = limits.length;
  const combination = new Array<number>(numButtons).fill(0);

  while (true) {
    yield combination.slice();

    let carry = true;
    for (let i = numButtons - 1; i >= 0 && carry; i--) {
      combination[i]!++;
      if (combination[i]! >= limits[i]!) {
        combination[i] = 0;
      } else {
        carry = false;
      }
    }

    if (carry) break;
  }
}

export function positionToIndex(x: number, y: number, gridWidth: number) {
  return BigInt(x + y * gridWidth);
}

export function indexToBitmask(index: bigint) {
  return 1n << index;
}

export function extractBit(bitmask: bigint, index: bigint) {
  return (bitmask >> index) & 1n;
}
