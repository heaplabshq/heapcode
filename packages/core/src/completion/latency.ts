const MAX_SAMPLES = 200;

export class LatencyTracker {
  private samples: number[] = [];
  private total = 0;

  record(ms: number): void {
    this.samples.push(ms);
    this.total++;
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, index)]!;
  }

  get count(): number {
    return this.total;
  }

  summary(): string {
    return `p50 ${this.percentile(50)}ms · p95 ${this.percentile(95)}ms · n=${this.total}`;
  }
}
