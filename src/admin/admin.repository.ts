import { BlockedDomain, FlaggedUrl, FlagState, PrismaClient } from '@prisma/client';
import { prisma } from '../shared/prisma';

/**
 * Repository for the abuse-prevention aggregates: `blocked_domains` and
 * `flagged_urls` (ADR-031/032). The ONLY place these tables are read/written
 * (ADR-010 layering) — it holds no authorization or business rules (those live
 * in the admin service + the role guard). All domain values are assumed already
 * canonicalized by the caller (the service owns that rule, ADR-034), mirroring
 * the users-repo "email already lowercased" contract.
 */

/** Fields persisted when an admin adds a blocklist entry (canonical domain). */
export interface CreateBlockedDomainData {
  /** The canonical registrable domain (ADR-034). UNIQUE → idempotent re-add. */
  domain: string;
  note: string | null;
  /** Server-set from the auth context, never the body (R12). */
  addedByUserId: string;
}

/** Fields persisted when screening FLAGs a candidate (ADR-032, PENDING). */
export interface CreateFlaggedUrlData {
  candidateUrl: string;
  ownerId: string;
  confidenceScore: number;
  flaggedReason: string;
}

/** Mutation applied to a flagged row on an admin terminal review. */
export interface ReviewFlaggedUrlData {
  state: FlagState;
  reviewedByUserId: string;
  reviewedAt: Date;
}

/**
 * Data access for blocklist + flagged-URL moderation.
 */
export class AdminRepository {
  /** @param db Injected Prisma client (defaults to the shared singleton). */
  constructor(private readonly db: PrismaClient = prisma) {}

  /**
   * Probe whether a canonical registrable domain is on the blocklist — the HOT
   * path on every POST /shorten. Equality on UNIQUE(domain) (ADR-031), a single
   * index probe, never a suffix scan.
   *
   * @param canonicalDomain The canonical registrable domain to look up.
   * @returns True if the domain is blocked.
   */
  async isBlocked(canonicalDomain: string): Promise<boolean> {
    const found = await this.db.blockedDomain.findUnique({
      where: { domain: canonicalDomain },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * Insert a blocklist entry. UNIQUE(domain) is the authoritative idempotency
   * guard; a duplicate surfaces as Prisma P2002, which the service maps to 409.
   *
   * @param data Canonical domain, optional note, and server-set curator id.
   * @returns The created blocklist entry.
   */
  async addBlockedDomain(data: CreateBlockedDomainData): Promise<BlockedDomain> {
    return this.db.blockedDomain.create({ data });
  }

  /**
   * List blocklist entries, newest first (small admin table).
   *
   * @returns All blocklist entries ordered by createdAt desc.
   */
  async listBlockedDomains(): Promise<BlockedDomain[]> {
    return this.db.blockedDomain.findMany({ orderBy: { createdAt: 'desc' } });
  }

  /**
   * Delete a blocklist entry by its canonical domain (uses UNIQUE(domain)).
   * Returns the deleted row count so the service can 404 on a miss without a
   * separate read.
   *
   * @param canonicalDomain The canonical registrable domain to remove.
   * @returns The number of rows deleted (0 or 1).
   */
  async removeBlockedDomain(canonicalDomain: string): Promise<number> {
    const result = await this.db.blockedDomain.deleteMany({ where: { domain: canonicalDomain } });
    return result.count;
  }

  /**
   * Persist a FLAGGED candidate as a PENDING row (ADR-032) — no live ShortUrl is
   * minted here (R25).
   *
   * @param data Candidate URL, owner, score, and reason.
   * @returns The created flagged row.
   */
  async createFlagged(data: CreateFlaggedUrlData): Promise<FlaggedUrl> {
    return this.db.flaggedUrl.create({ data });
  }

  /**
   * List the moderation queue: PENDING flags oldest-first (served by the partial
   * `(state, created_at) WHERE state='PENDING'` index, no sort).
   *
   * @returns Pending flagged URLs, oldest first.
   */
  async listPendingFlagged(): Promise<FlaggedUrl[]> {
    return this.db.flaggedUrl.findMany({
      where: { state: FlagState.PENDING },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Look up a flagged row by its UUID id (admin approve/reject path). Unscoped:
   * the admin moderation queue spans all submitters; the service applies the
   * 404-on-missing + PENDING-only state guard.
   *
   * @param id The flagged row UUID.
   * @returns The flagged row, or null if no such id exists.
   */
  async findFlaggedById(id: string): Promise<FlaggedUrl | null> {
    return this.db.flaggedUrl.findUnique({ where: { id } });
  }

  /**
   * Apply a terminal review (APPROVED/REJECTED + reviewer + timestamp) to a
   * flagged row. The service guarantees the row is PENDING before calling.
   *
   * @param id The flagged row UUID.
   * @param data The terminal state, reviewer id, and review time.
   * @returns The updated flagged row.
   */
  async reviewFlagged(id: string, data: ReviewFlaggedUrlData): Promise<FlaggedUrl> {
    return this.db.flaggedUrl.update({ where: { id }, data });
  }

  /**
   * Delete a flagged row by id (used when a REJECT discards the submission).
   *
   * @param id The flagged row UUID.
   * @returns A promise that resolves once the row is deleted.
   */
  async deleteFlagged(id: string): Promise<void> {
    await this.db.flaggedUrl.delete({ where: { id } });
  }
}
