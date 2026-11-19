import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Node's process.loadEnvFile() writes into process.env via an internal binding tied to the
 * real process realm. Under Jest's VM-sandboxed `node` test environment that write (and the
 * Error identity of a thrown ENOENT) doesn't reliably cross back into the sandboxed
 * process.env / Error seen by test code, so loadDotEnvFile is exercised here in a real child
 * process instead of by calling it in-process.
 */
function runLoadDotEnvFile(envPath: string, presetEnv: Record<string, string> = {}): string {
  const script = [
    "const { loadDotEnvFile } = require('./src/config/load-dotenv');",
    `loadDotEnvFile(${JSON.stringify(envPath)});`,
    'process.stdout.write(process.env.PORT ?? "");',
  ].join('\n');

  // Strip any PORT this test process inherited so each case starts from a clean slate,
  // then apply the case's preset (simulating a "real" environment variable already set).
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.PORT;
  Object.assign(childEnv, presetEnv);

  const backendRoot = join(__dirname, '..', '..');
  const tsNodeBin = join(backendRoot, 'node_modules', '.bin', 'ts-node');

  return execFileSync(tsNodeBin, ['-e', script], {
    cwd: backendRoot,
    encoding: 'utf-8',
    env: childEnv,
  });
}

describe('loadDotEnvFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trustflow-dotenv-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads a value present only in .env into process.env', () => {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'PORT=4321\n');

    const result = runLoadDotEnvFile(envPath);

    expect(result).toBe('4321');
  }, 20000);

  it('does not override a variable already set in the real environment', () => {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'PORT=4321\n');

    const result = runLoadDotEnvFile(envPath, { PORT: '9999' });

    expect(result).toBe('9999');
  }, 20000);

  it('is a no-op when the .env file does not exist', () => {
    const envPath = join(dir, 'does-not-exist.env');

    const result = runLoadDotEnvFile(envPath);

    expect(result).toBe('');
  }, 20000);

  it('gives precedence to backend/.env when both backend/.env and root .env exist (#920)', () => {
    const rootEnv = join(dir, '.env');
    const backendEnv = join(dir, 'backend', '.env');
    const { mkdirSync, writeFileSync } = require('fs');
    mkdirSync(join(dir, 'backend'));
    writeFileSync(rootEnv, 'PORT=1111\n');
    writeFileSync(backendEnv, 'PORT=2222\n');

    const result = runLoadDotEnvFile(backendEnv);
    expect(result).toBe('2222');
  }, 20000);
});
