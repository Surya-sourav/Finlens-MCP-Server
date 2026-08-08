export interface TenantRow {
  id: string;
  workosUserId: string;
  workosOrgId: string;
  email: string;
}

export interface TenantRepo {
  findByWorkos(workosUserId: string, workosOrgId: string): Promise<TenantRow | null>;
  create(input: { workosUserId: string; workosOrgId: string; email: string }): Promise<TenantRow>;
}
