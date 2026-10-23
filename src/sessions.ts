import { randomUUID } from 'node:crypto';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface Session {
  id: string;
  turns: ChatTurn[];
  updatedAt: number;
  busy: boolean;
}

export interface SessionStoreOptions {
  /** Messages kept per session (user + assistant each count as one). */
  maxMessages: number;
  ttlMs: number;
  maxSessions: number;
  now?: () => number;
}

/**
 * In-memory conversation context: text only, never audio.
 * Lost on restart; use a shared store (e.g. Redis) when running more than one instance.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();
  private readonly now: () => number;

  constructor(private readonly options: SessionStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Returns the live session, or a new one if the id is unknown or expired. */
  getOrCreate(id: string | undefined): { session: Session; isNew: boolean } {
    this.evictExpired();
    const existing = id ? this.sessions.get(id) : undefined;
    if (existing) {
      // Re-insert so Map order tracks recency for LRU eviction.
      this.sessions.delete(existing.id);
      this.sessions.set(existing.id, existing);
      return { session: existing, isNew: false };
    }
    const session: Session = { id: id ?? randomUUID(), turns: [], updatedAt: this.now(), busy: false };
    this.sessions.set(session.id, session);
    while (this.sessions.size > this.options.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return { session, isNew: true };
  }

  history(session: Session): ChatTurn[] {
    return [...session.turns];
  }

  /** Commits a completed exchange; failed requests never reach history. */
  append(session: Session, user: string, assistant: string): void {
    session.turns.push({ role: 'user', content: user }, { role: 'assistant', content: assistant });
    const overflow = session.turns.length - this.options.maxMessages;
    if (overflow > 0) session.turns.splice(0, overflow + (overflow % 2));
    session.updatedAt = this.now();
  }

  reset(session: Session): void {
    session.turns = [];
    session.updatedAt = this.now();
  }

  /** One request per session at a time keeps turns in order. */
  tryLock(session: Session): boolean {
    if (session.busy) return false;
    session.busy = true;
    return true;
  }

  unlock(session: Session): void {
    session.busy = false;
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.options.ttlMs;
    for (const [id, session] of this.sessions) {
      if (session.updatedAt < cutoff && !session.busy) this.sessions.delete(id);
    }
  }
}
