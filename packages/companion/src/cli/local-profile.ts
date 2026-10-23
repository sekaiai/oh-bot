import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import { characters } from '../database/schema/index.js';

export type LocalCliProfile = Readonly<{ version: 1; characterId: string; userId: string; channelId: string }>;
const profilePattern = /^\{"version":1,"characterId":"([0-9a-f-]{36})","userId":"local-cli:user:([0-9a-f-]{36})","channelId":"local-cli:channel:([0-9a-f-]{36})"\}\n?$/;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function decodeProfile(contents: string): LocalCliProfile {
  const match = profilePattern.exec(contents);
  if (!match) throw new Error('local_profile_invalid');
  const profile = JSON.parse(contents) as LocalCliProfile;
  if (![profile.characterId, profile.userId.slice('local-cli:user:'.length), profile.channelId.slice('local-cli:channel:'.length)].every((value) => uuidV4.test(value))) throw new Error('local_profile_invalid');
  return Object.freeze(profile);
}

export async function loadOrCreateLocalProfile(path: string): Promise<LocalCliProfile> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('local_profile_invalid');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('local_profile_invalid');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new Error('local_profile_invalid'); });
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || (opened.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && opened.uid !== process.getuid())) throw new Error('local_profile_invalid');
      return decodeProfile(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error instanceof Error && error.message === 'local_profile_invalid' ? error : new Error('local_profile_invalid');
  }
  const profile: LocalCliProfile = Object.freeze({ version: 1, characterId: randomUUID(), userId: `local-cli:user:${randomUUID()}`, channelId: `local-cli:channel:${randomUUID()}` });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => { throw new Error('local_profile_unavailable'); });
  const handle = await open(path, 'wx', 0o600).catch(() => { throw new Error('local_profile_unavailable'); });
  try {
    await handle.writeFile(`${JSON.stringify(profile)}\n`, 'utf8');
    await handle.sync();
    await chmod(path, 0o600);
  } catch {
    throw new Error('local_profile_unavailable');
  } finally { await handle.close(); }
  return profile;
}

export async function ensureLocalCharacter(database: Database, profile: LocalCliProfile): Promise<void> {
  const [existing] = await database.db.select({ id: characters.id, name: characters.name }).from(characters).where(eq(characters.id, profile.characterId)).limit(1);
  if (existing) {
    if (existing.name !== `Local CLI ${profile.characterId}`) throw new Error('local_profile_character_conflict');
    return;
  }
  await database.db.insert(characters).values({ id: profile.characterId, name: `Local CLI ${profile.characterId}` }).onConflictDoNothing();
}
