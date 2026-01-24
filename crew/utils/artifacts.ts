/**
 * Crew - Debug Artifacts
 * 
 * Writes debug files for troubleshooting agent failures.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ArtifactPaths {
  inputPath: string;
  outputPath: string;
  jsonlPath: string;
  metadataPath: string;
}

export function getArtifactPaths(
  artifactsDir: string,
  runId: string,
  agent: string,
  index?: number
): ArtifactPaths {
  const suffix = index !== undefined ? `_${index}` : "";
  const safeAgent = agent.replace(/[^\w.-]/g, "_");
  const base = `${runId}_${safeAgent}${suffix}`;

  return {
    inputPath: path.join(artifactsDir, `${base}_input.md`),
    outputPath: path.join(artifactsDir, `${base}_output.md`),
    jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
    metadataPath: path.join(artifactsDir, `${base}_meta.json`),
  };
}

export function ensureArtifactsDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeArtifact(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf-8");
}

export function writeMetadata(filePath: string, metadata: object): void {
  fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}

export function appendJsonl(filePath: string, line: string): void {
  fs.appendFileSync(filePath, `${line}\n`);
}

export function cleanupOldArtifacts(dir: string, maxAgeDays: number): void {
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

  for (const file of fs.readdirSync(dir)) {
    const filePath = path.join(dir, file);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore errors
    }
  }
}
