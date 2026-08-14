import { Injectable } from "@nestjs/common";
import * as OTPAuth from "otpauth";

const PERIOD_SECONDS = 30;
const VALIDATION_WINDOW = 1; // ±1 period (±30s), the standard TOTP clock-skew tolerance

export interface EnrollmentSecret {
  base32Secret: string;
  provisioningUri: string;
}

// Real RFC 6238 TOTP via otpauth — v8 (CJS build) rather than the
// current v9, which is ESM-only and would conflict with this backend's
// CommonJS build, same reasoning as WO-018's openid-client v5 pin.
@Injectable()
export class TotpProviderService {
  generateSecret(issuer: string, label: string): EnrollmentSecret {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({ issuer, label, secret, algorithm: "SHA1", digits: 6, period: PERIOD_SECONDS });
    return { base32Secret: secret.base32, provisioningUri: totp.toString() };
  }

  /** Returns the matched period NUMBER (for replay tracking) if valid, or null if the code doesn't match within the tolerance window. */
  validate(base32Secret: string, token: string, timestamp: number = Date.now()): number | null {
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(base32Secret),
      algorithm: "SHA1",
      digits: 6,
      period: PERIOD_SECONDS,
    });
    const delta = totp.validate({ token, timestamp, window: VALIDATION_WINDOW });
    if (delta === null) return null;
    return this.currentPeriod(timestamp) + delta;
  }

  currentPeriod(timestamp: number = Date.now()): number {
    return Math.floor(timestamp / 1000 / PERIOD_SECONDS);
  }
}
