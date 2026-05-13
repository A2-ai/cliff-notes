import pc from "picocolors";

export interface Progress {
  step(label: string, msg: string): void;
  done(msg: string): void;
}

export interface ProgressOptions {
  quiet: boolean;
  isTTY: boolean;
}

const LABEL_WIDTH = 10;

export function makeProgress(opts: ProgressOptions): Progress {
  if (opts.quiet || !opts.isTTY) {
    return { step: () => {}, done: () => {} };
  }
  return {
    step(label, msg) {
      process.stderr.write(`${pc.dim("→")} ${pc.dim(label.padEnd(LABEL_WIDTH))} ${msg}\n`);
    },
    done(msg) {
      process.stderr.write(`${pc.green("✓")} ${msg}\n`);
    },
  };
}
