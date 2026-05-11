import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT_MARKERS = ['pnpm-workspace.yaml', 'turbo.json', '.git'];

/**
 * Finds the monorepo/workspace root even when the worker is launched from apps/worker.
 */
export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir);

  while (true) {
    const hasRootMarker = ROOT_MARKERS.some((marker) => existsSync(resolve(current, marker)));
    if (hasRootMarker) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(startDir);
    }

    current = parent;
  }
}
