import { join } from 'path';
import { existsSync } from 'fs';

/**
 * Loads environment variables from .env files into process.env.
 *
 * Precedence rule (#920):
 * If both root `.env` and `backend/.env` exist, `backend/.env` takes precedence
 * as the documented primary source of truth for the backend application.
 * When both exist, a warning is emitted so users with stale root `.env` files
 * are explicitly informed of the precedence.
 * Real environment variables already present in process.env always take precedence
 * over any file.
 */
export function loadDotEnvFile(path?: string): void {
  if (!path) {
    const defaultBackendEnv = join(process.cwd(), '.env');
    const rootEnv = join(process.cwd(), '..', '.env');

    // Check if both backend/.env and root .env exist
    if (existsSync(defaultBackendEnv) && existsSync(rootEnv)) {
      console.warn(
        '[loadDotEnvFile] Warning: Both root .env and backend/.env detected. ' +
        'backend/.env takes precedence as the primary configuration source.',
      );
    }

    // Load backend/.env first (primary source of truth)
    tryLoad(defaultBackendEnv);
    // Then load root .env as fallback (Node process.loadEnvFile never overrides existing process.env variables)
    tryLoad(rootEnv);
    return;
  }

  tryLoad(path);
}

function tryLoad(filePath: string): void {
  try {
    process.loadEnvFile(filePath);
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}