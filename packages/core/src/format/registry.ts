// Format adapter registry. Maps file extensions and format names to adapters.

import type { FormatAdapter } from "./adapter.js";
import { extname } from "node:path";

const byFormat = new Map<string, FormatAdapter>();
const byExtension = new Map<string, FormatAdapter>();

export function registerAdapter(adapter: FormatAdapter): void {
  byFormat.set(adapter.format, adapter);
  for (const ext of adapter.extensions) {
    byExtension.set(ext.toLowerCase(), adapter);
  }
}

export function adapterForFormat(format: string): FormatAdapter | undefined {
  return byFormat.get(format);
}

export function adapterForPath(filePath: string): FormatAdapter | undefined {
  const ext = extname(filePath).toLowerCase();
  return byExtension.get(ext);
}

export function registeredFormats(): string[] {
  return [...byFormat.keys()];
}

export function detectFormat(filePath: string): string | undefined {
  return adapterForPath(filePath)?.format;
}
