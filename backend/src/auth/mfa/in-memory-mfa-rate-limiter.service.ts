import { Injectable } from "@nestjs/common";
import { MAX_ATTEMPTS, WINDOW_SECONDS, type MfaRateLimiterPort } from "./mfa-rate-limiter.port";

interface Window {
  count: number;
  windowStart: number;
}

@Injectable()
export class InMemoryMfaRateLimiter implements MfaRateLimiterPort {
  private readonly windows = new Map<string, Window>();

  async checkAndRecordAttempt(userId: string): Promise<{ limited: boolean; attemptsRemaining: number }> {
    const now = Date.now();
    let window = this.windows.get(userId);

    if (!window || now - window.windowStart >= WINDOW_SECONDS * 1000) {
      window = { count: 0, windowStart: now };
      this.windows.set(userId, window);
    }

    if (window.count >= MAX_ATTEMPTS) {
      return { limited: true, attemptsRemaining: 0 };
    }

    window.count += 1;
    return { limited: false, attemptsRemaining: Math.max(0, MAX_ATTEMPTS - window.count) };
  }

  async reset(userId: string): Promise<void> {
    this.windows.delete(userId);
  }
}
