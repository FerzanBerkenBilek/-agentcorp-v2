import { BlockedDomain, FlaggedUrl, FlagState, Prisma } from '@prisma/client';
import { ConflictError, ValidationError } from '../shared/errors';
import { canonicalizeRegistrableDomain } from '../shared/domain-canonical';
import { UrlsService } from '../urls/urls.service';
import { assertReviewable } from './admin.policy';
import { AdminRepository } from './admin.repository';

/**
 * Admin abuse-prevention business logic (ADR-031/032/034): blocklist curation +
 * flagged-URL moderation. Framework-agnostic — it knows nothing about HTTP. The
 * role guard (`requireRole('admin')`) lives in the route layer; this service
 * assumes the caller is already an authenticated admin and focuses on the rules:
 * canonicalize-on-write, idempotent add (409), state-machine review (404/409),
 * and minting the live ShortUrl on approve via the injected UrlsService.
 */

/** Prisma unique-constraint violation code (UNIQUE(domain) idempotency, R12). */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

export class AdminService {
  /**
   * @param repo Abuse-prevention repository (blocklist + flagged data access).
   * @param urls URL service — used to mint the live ShortUrl when a flagged
   *   submission is APPROVED (ADR-032), reusing the ADR-022 insert-retry.
   */
  constructor(
    private readonly repo: AdminRepository,
    private readonly urls: UrlsService,
  ) {}

  /**
   * Add a domain to the blocklist. The raw admin input is canonicalized to its
   * registrable form (the SAME pipeline the screen uses, ADR-034) before
   * persistence, so screen-time equality always matches. UNIQUE(domain) makes a
   * re-add idempotent → 409 (R12).
   *
   * @param adminId The authenticated admin (server-set curator, never the body).
   * @param rawDomain The admin-supplied domain string.
   * @param note Optional curator note.
   * @returns The created blocklist entry.
   * @throws ValidationError if the domain cannot be canonicalized (422).
   * @throws ConflictError if the domain is already blocked (409).
   */
  async addToBlocklist(adminId: string, rawDomain: string, note?: string): Promise<BlockedDomain> {
    const domain = this.canonicalizeOrThrow(rawDomain);
    try {
      return await this.repo.addBlockedDomain({ domain, note: note ?? null, addedByUserId: adminId });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('Domain is already on the blocklist');
      }
      throw error;
    }
  }

  /**
   * List all blocklist entries (newest first).
   *
   * @returns The blocklist entries.
   */
  async listBlocklist(): Promise<BlockedDomain[]> {
    return this.repo.listBlockedDomains();
  }

  /**
   * Remove a domain from the blocklist. The param is canonicalized so an admin
   * can pass any form (`EVIL.com`, `a.b.evil.com`) and still hit the stored
   * registrable row. A miss is a 404 (the entry does not exist).
   *
   * @param rawDomain The admin-supplied domain to remove.
   * @returns void
   * @throws ValidationError if the domain cannot be canonicalized (422).
   * @throws NotFoundError-equivalent handled by the route via the 0-count return.
   */
  async removeFromBlocklist(rawDomain: string): Promise<{ removed: boolean }> {
    const domain = this.canonicalizeOrThrow(rawDomain);
    const count = await this.repo.removeBlockedDomain(domain);
    return { removed: count > 0 };
  }

  /**
   * Persist a screening FLAG as a PENDING row (ADR-032/R25) — no live ShortUrl.
   *
   * @param ownerId The submitter.
   * @param candidateUrl The validated, normalized URL that scored in the FLAG band.
   * @param confidenceScore The 0–100 confidence (exact integer).
   * @param flaggedReason The machine reason from the screen (audited, not shown).
   * @returns The created PENDING flagged row.
   */
  async recordFlag(
    ownerId: string,
    candidateUrl: string,
    confidenceScore: number,
    flaggedReason: string,
  ): Promise<FlaggedUrl> {
    return this.repo.createFlagged({ ownerId, candidateUrl, confidenceScore, flaggedReason });
  }

  /**
   * List the moderation queue (PENDING flags, oldest first).
   *
   * @returns Pending flagged URLs.
   */
  async listFlagged(): Promise<FlaggedUrl[]> {
    return this.repo.listPendingFlagged();
  }

  /**
   * Approve a flagged submission: validate the state machine, mint a live
   * ShortUrl for the original submitter (ADR-032 — the code is assigned at
   * approval time, R-proposed_code), then mark the row APPROVED.
   *
   * @param adminId The reviewing admin.
   * @param id The flagged row UUID.
   * @returns The minted short URL's public code.
   * @throws NotFoundError (404) if the id is unknown; ConflictError (409) if terminal.
   */
  async approveFlagged(adminId: string, id: string): Promise<{ code: string }> {
    const flagged = assertReviewable(await this.repo.findFlaggedById(id));
    const url = await this.urls.createApproved(flagged.ownerId, flagged.candidateUrl);
    await this.repo.reviewFlagged(id, {
      state: FlagState.APPROVED,
      reviewedByUserId: adminId,
      reviewedAt: new Date(),
    });
    return { code: url.code };
  }

  /**
   * Reject a flagged submission: validate the state machine, then DELETE the row
   * (ADR-032 — a rejected candidate mints nothing and is discarded; the audit
   * log retains the decision record).
   *
   * @param _adminId The reviewing admin (audited by the route; the row is
   *   deleted, so no reviewer attribution is persisted on REJECT).
   * @param id The flagged row UUID.
   * @returns void
   * @throws NotFoundError (404) if the id is unknown; ConflictError (409) if terminal.
   */
  async rejectFlagged(_adminId: string, id: string): Promise<void> {
    assertReviewable(await this.repo.findFlaggedById(id));
    await this.repo.deleteFlagged(id);
  }

  /**
   * Canonicalize an admin-supplied domain to its registrable form, rejecting an
   * uncanonicalizable input as a 422 (fail closed — we never store a garbage
   * blocklist key that screen-time would never match).
   *
   * @param rawDomain The admin-supplied domain string.
   * @returns The canonical registrable domain.
   * @throws ValidationError if the domain cannot be canonicalized.
   */
  private canonicalizeOrThrow(rawDomain: string): string {
    const canonical = canonicalizeRegistrableDomain(rawDomain);
    if (canonical === null) {
      throw new ValidationError('Invalid domain', [{ path: 'domain', message: 'Not a valid domain' }]);
    }
    return canonical;
  }
}

/**
 * True if the error is a Prisma unique-constraint (P2002) violation.
 *
 * @param error The caught error.
 * @returns Whether it is a P2002 known-request error.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === PRISMA_UNIQUE_VIOLATION
  );
}
