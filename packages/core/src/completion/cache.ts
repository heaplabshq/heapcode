/**
 * Reuses the previous completion while the user types "through" it:
 * if they've typed exactly the first N chars of what we suggested, serve the
 * remainder instantly instead of re-requesting.
 */
export class PrefixCache {
  private key?: string;
  private prefix?: string;
  private completion?: string;

  set(key: string, prefix: string, completion: string): void {
    this.key = key;
    this.prefix = prefix;
    this.completion = completion;
  }

  get(key: string, prefix: string): string | undefined {
    if (key !== this.key || this.prefix === undefined || !this.completion) return undefined;
    if (prefix === this.prefix) return this.completion;
    if (prefix.startsWith(this.prefix)) {
      const typed = prefix.slice(this.prefix.length);
      if (this.completion.startsWith(typed) && typed.length < this.completion.length) {
        return this.completion.slice(typed.length);
      }
    }
    return undefined;
  }

  clear(): void {
    this.key = undefined;
    this.prefix = undefined;
    this.completion = undefined;
  }
}
