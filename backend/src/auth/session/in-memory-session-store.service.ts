import { Injectable } from "@nestjs/common";
import type { SessionRecord, SessionStorePort } from "./session-store.port";

@Injectable()
export class InMemorySessionStore implements SessionStorePort {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly sessionsByUser = new Map<string, Set<string>>();

  async create(record: SessionRecord): Promise<void> {
    this.sessions.set(record.sessionId, record);
    const userSessions = this.sessionsByUser.get(record.userId) ?? new Set<string>();
    userSessions.add(record.sessionId);
    this.sessionsByUser.set(record.userId, userSessions);
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async touch(sessionId: string, lastActivityAt: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = lastActivityAt;
    }
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (session) {
      this.sessionsByUser.get(session.userId)?.delete(sessionId);
    }
  }

  async listSessionIdsForUser(userId: string): Promise<string[]> {
    return [...(this.sessionsByUser.get(userId) ?? [])];
  }
}
