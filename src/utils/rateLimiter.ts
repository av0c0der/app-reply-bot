interface RateLimitState {
    count: number;
    resetAt: number;
}

interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt: number;
}

/**
 * Simple in-memory rate limiter keyed by string identifiers.
 * Not distributed; intended for single-process throttling.
 */
export class RateLimiter {
    private limit: number;
    private windowMs: number;
    private buckets: Map<string, RateLimitState> = new Map();

    constructor(limit: number, windowMs: number) {
        this.limit = Math.max(0, limit);
        this.windowMs = windowMs;
    }

    tryConsume(key: string): RateLimitResult {
        const now = Date.now();
        const existing = this.buckets.get(key);

        if (!existing || now >= existing.resetAt) {
            const resetAt = now + this.windowMs;
            const remaining = Math.max(this.limit - 1, 0);
            this.buckets.set(key, { count: 1, resetAt });
            return { allowed: this.limit > 0, remaining, resetAt };
        }

        const nextCount = existing.count + 1;
        const allowed = nextCount <= this.limit;
        const remaining = allowed ? this.limit - nextCount : 0;

        if (allowed) {
            this.buckets.set(key, { count: nextCount, resetAt: existing.resetAt });
        }

        return { allowed, remaining, resetAt: existing.resetAt };
    }
}
