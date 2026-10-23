import fs from 'fs';
import os from 'os';
import path from 'path';

function tempDirCandidates(): string[] {
  return [
    process.env.TRANSCRIBE_TMPDIR?.trim(),
    process.env.TMPDIR?.trim(),
    process.env.TEMP?.trim(),
    os.tmpdir(),
    '/tmp',
  ].filter((value): value is string => Boolean(value));
}

export async function resolveWritableTempRoot(): Promise<string> {
  for (const dir of tempDirCandidates()) {
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.access(dir, fs.constants.W_OK);
      return dir;
    } catch {
      continue;
    }
  }

  throw new Error('No writable temp directory available');
}

export async function createTempDirectory(prefix: string): Promise<string> {
  const tempRoot = await resolveWritableTempRoot();
  return fs.promises.mkdtemp(path.join(tempRoot, prefix));
}

export async function createTempFilePath(prefix: string, suffix: string): Promise<string> {
  const tempRoot = await resolveWritableTempRoot();
  return path.join(tempRoot, `${prefix}${Date.now()}${suffix}`);
}
