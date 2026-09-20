export class Progress {
  private label: string;
  private last = 0;
  private started = Date.now();
  private tty = process.stdout.isTTY === true;

  constructor(label: string) {
    this.label = label;
  }

  update(done: number, total: number): void {
    const now = Date.now();
    if (done < total && now - this.last < 120) return;
    this.last = now;
    const elapsed = (now - this.started) / 1000;
    const rate = done / Math.max(0.001, elapsed);
    const eta = rate > 0 ? (total - done) / rate : 0;
    const pct = total ? done / total : 1;
    const line =
      `  ${this.label.padEnd(12)} ${bar(pct)} ${String(done).padStart(String(total).length)}/${total}` +
      `  ${rate.toFixed(1)}/s  ${elapsed.toFixed(0)}s${done < total ? ` · eta ${eta.toFixed(0)}s` : ""}`;
    if (this.tty) process.stdout.write(`\r${line.padEnd(92)}`);
    else if (done === total) process.stdout.write(`${line}\n`);
  }

  done(): void {
    if (this.tty) process.stdout.write("\n");
  }
}

const bar = (pct: number, width = 24): string => {
  const filled = Math.round(Math.min(1, Math.max(0, pct)) * width);
  return `[${"█".repeat(filled)}${"·".repeat(width - filled)}]`;
};

export const fmtMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export const fmtUsd = (n: number): string => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
