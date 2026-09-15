type Entry = { value: string; bytes: number; expiresAt: number };
type CacheStatus = "hit" | "miss" | "shared";

/** Bounded LRU of serialized reports; simultaneous identical loads share work. */
export class ReportCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<string>>();
  private bytes = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxBytes: number,
    private readonly maxEntries = 128,
    private readonly now = Date.now
  ) {}

  async get(key: string, load: () => Promise<string>): Promise<{ value: string; status: CacheStatus }> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return { value: cached.value, status: "hit" };
    }
    if (cached) this.remove(key);
    const pending = this.pending.get(key);
    if (pending) return { value: await pending, status: "shared" };

    // Bound bookkeeping even when many distinct filters arrive together.
    if (this.pending.size >= this.maxEntries) return { value: await load(), status: "miss" };
    const task = Promise.resolve().then(load).then((value) => {
      const bytes = Buffer.byteLength(value, "utf8");
      if (this.ttlMs > 0 && bytes <= this.maxBytes) {
        for (const [entryKey, entry] of this.entries) {
          if (entry.expiresAt <= this.now()) this.remove(entryKey);
        }
        while (this.entries.size && (this.bytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries)) {
          this.remove(this.entries.keys().next().value!);
        }
        this.entries.set(key, { value, bytes, expiresAt: this.now() + this.ttlMs });
        this.bytes += bytes;
      }
      return value;
    });
    this.pending.set(key, task);
    try {
      return { value: await task, status: "miss" };
    } finally {
      this.pending.delete(key);
    }
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}
