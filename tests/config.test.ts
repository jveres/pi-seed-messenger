import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirs, type TempDirs } from "./helpers/temp-dirs.js";

const homedirMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: homedirMock,
  };
});

async function loadConfigModule() {
  vi.resetModules();
  return import("../config.js");
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

describe("config", () => {
  let dirs: TempDirs;

  beforeEach(() => {
    dirs = createTempDirs();
    homedirMock.mockReset();
    homedirMock.mockReturnValue(path.join(dirs.root, ".pi-home"));
  });

  it("defaults autoStatus to true", async () => {
    const { loadConfig } = await loadConfigModule();
    const cfg = loadConfig(dirs.cwd);
    expect(cfg.autoStatus).toBe(true);
  });

  it("applies project override for autoRegister", async () => {
    const homeDir = path.join(dirs.root, ".pi-home");
    writeJson(path.join(homeDir, ".pi", "agent", "pi-messenger.json"), {
      autoRegister: false,
    });
    writeJson(path.join(dirs.cwd, ".pi", "pi-messenger.json"), {
      autoRegister: true,
    });

    const { loadConfig } = await loadConfigModule();
    const cfg = loadConfig(dirs.cwd);

    expect(cfg.autoRegister).toBe(true);
  });
});
