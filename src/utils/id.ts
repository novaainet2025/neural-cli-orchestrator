import { nanoid } from 'nanoid';

export function createId(prefix?: string): string {
  const id = nanoid(16);
  return prefix ? `${prefix}_${id}` : id;
}

export function createTaskId(): string {
  return createId('task');
}

export function createSessionId(): string {
  return createId('sess');
}

export function createArtifactId(): string {
  return createId('art');
}

export function createMessageId(): string {
  return createId('msg');
}

export function createEventId(): string {
  return createId('evt');
}
