export const MFA_RATE_LIMITER = "MFA_RATE_LIMITER";

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 5 * 60;

export { MAX_ATTEMPTS, WINDOW_SECONDS };

// Production is intended to back this with Redis (a counter shared
// across API instances is what actually stops a distributed brute-force
// attempt), same connector-gap reasoning as every other *Port in this
// auth module — InMemoryMfaRateLimiter is a real, functional
// single-instance implementation, not a stub.
export interface MfaRateLimiterPort {
  /** Records one attempt and returns whether the user is CURRENTLY rate-limited (i.e. this attempt itself should be rejected before even checking the code). */
  checkAndRecordAttempt(userId: string): Promise<{ limited: boolean; attemptsRemaining: number }>;

  /** Clears the counter — called on a successful verification, so a legitimate user isn't left one typo away from lockout after finally getting it right. */
  reset(userId: string): Promise<void>;
}
