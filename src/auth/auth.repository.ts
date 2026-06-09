import { PrismaClient, RefreshToken } from '@prisma/client';
import { prisma } from '../shared/prisma';

/** Data required to persist a newly issued refresh token. */
export interface PersistRefreshTokenData {
  hashedToken: string;
  family: string;
  jti: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Repository for the RefreshToken aggregate (ADR-012 rotation + reuse
 * detection). The service never sees the table directly; this is the only
 * place RefreshToken rows are read/written. Tokens are always stored as a
 * SHA-256 hash — plaintext never reaches the DB (H2).
 */
export class AuthRepository {
  /** @param db Injected Prisma client (defaults to the shared singleton). */
  constructor(private readonly db: PrismaClient = prisma) {}

  /**
   * Persist a newly issued refresh token (hashed).
   *
   * @param data The hashed token, rotation family, jti, owner, and expiry.
   * @returns The created RefreshToken row.
   */
  async createToken(data: PersistRefreshTokenData): Promise<RefreshToken> {
    return this.db.refreshToken.create({ data });
  }

  /**
   * Look up a refresh token row by its SHA-256 hash.
   *
   * @param hashedToken SHA-256 hex digest of the presented token.
   * @returns The matching row, or null if no such token was ever issued.
   */
  async findByHash(hashedToken: string): Promise<RefreshToken | null> {
    return this.db.refreshToken.findUnique({ where: { hashedToken } });
  }

  /**
   * Mark a single token row as revoked/consumed (sets revokedAt = now).
   *
   * @param id The RefreshToken row id.
   * @returns A promise that resolves once the row is updated.
   */
  async revokeById(id: string): Promise<void> {
    await this.db.refreshToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Revoke every still-active token in a rotation family (H2 reuse response).
   *
   * @param family The rotation family UUID.
   * @returns The number of rows revoked.
   */
  async revokeFamily(family: string): Promise<number> {
    const result = await this.db.refreshToken.updateMany({
      where: { family, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}
