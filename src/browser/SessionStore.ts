import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

/** Persistent on-disk state: profile dir + cached gateway function id. */
export function profileDir(): string {
  const dir = process.env.BROWSER_PROFILE_DIR || join(process.cwd(), '.browser-profile');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionFile(): string {
  return join(process.cwd(), '.session.json');
}
