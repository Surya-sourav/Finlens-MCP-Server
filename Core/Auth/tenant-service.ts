import type { TenantRepo } from "./tenant-repo.js";

export interface TenantIdentity {
  workosUserId: string;
  workosOrgId: string | null;
  email: string | null;
}

/**
 * Maps a verified WorkOS identity to a stable internal tenant id, creating the
 * tenant row on first sight. The tenant key is (workosUserId, workosOrgId); when
 * the token carries no org, the user id is used as the org key so a personal
 * user maps to one stable tenant.
 */
export class TenantService {
  constructor(private readonly repo: TenantRepo) {}

  async findOrCreate(identity: TenantIdentity): Promise<string> {
    const orgKey = identity.workosOrgId ?? identity.workosUserId;
    const existing = await this.repo.findByWorkos(identity.workosUserId, orgKey);
    if (existing) {
      return existing.id;
    }
    const created = await this.repo.create({
      workosUserId: identity.workosUserId,
      workosOrgId: orgKey,
      email: identity.email ?? "",
    });
    return created.id;
  }
}
