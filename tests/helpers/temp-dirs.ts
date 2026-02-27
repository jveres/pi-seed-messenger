import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "vitest";

const roots = new Set<string>();

export interface TempDirs {
  root: string;
  cwd: string;
}

export function createTempDirs(): TempDirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-test-"));
  roots.add(root);

  const cwd = root;
  const messengerDir = path.join(cwd, ".pi", "messenger");

  fs.mkdirSync(messengerDir, { recursive: true });

  return { root, cwd };
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});
