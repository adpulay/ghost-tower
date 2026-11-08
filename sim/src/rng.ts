// Seeded randomness: same seed string = same run, every time (demo insurance).
// xmur3 string hash -> sfc32 generator. Each concern gets its own named stream so adding
// e.g. a new benign noise type doesn't reshuffle where the phones are.

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export class Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: string) {
    const s = xmur3(seed);
    this.#a = s();
    this.#b = s();
    this.#c = s();
    this.#d = s();
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Uniform in [0, 1). */
  next(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
    this.#d = (this.#d + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#c = (this.#c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Poisson-distributed count (Knuth; normal approximation for big means). */
  poisson(mean: number): number {
    if (mean <= 0) return 0;
    if (mean > 30) return Math.max(0, Math.round(mean + Math.sqrt(mean) * this.gauss()));
    const L = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > L);
    return k - 1;
  }

  gauss(): number {
    const u = 1 - this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }

  /** Uniform point in a disc of radius r (meters), as east/north offsets. */
  disc(r: number): { e: number; n: number } {
    const rr = r * Math.sqrt(this.next());
    const a = 2 * Math.PI * this.next();
    return { e: rr * Math.sin(a), n: rr * Math.cos(a) };
  }
}
