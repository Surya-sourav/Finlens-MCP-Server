import { describe, it, expect, beforeEach } from '@jest/globals';
import type { TenantRepo, TenantRow } from '../../../Core/Auth/tenant-repo.js';

const { TenantService } = await import('../../../Core/Auth/tenant-service.js');

class InMemoryTenantRepo implements TenantRepo {
  rows: TenantRow[] = [];
  private seq = 0;
  createCalls = 0;

  async findByWorkos(workosUserId: string, workosOrgId: string): Promise<TenantRow | null> {
    return this.rows.find((r) => r.workosUserId === workosUserId && r.workosOrgId === workosOrgId) ?? null;
  }

  async create(input: { workosUserId: string; workosOrgId: string; email: string }): Promise<TenantRow> {
    this.createCalls++;
    const row: TenantRow = { id: `t${++this.seq}`, ...input };
    this.rows.push(row);
    return row;
  }
}

let repo: InMemoryTenantRepo;
let service: InstanceType<typeof TenantService>;

beforeEach(() => {
  repo = new InMemoryTenantRepo();
  service = new TenantService(repo);
});

describe('TenantService.findOrCreate', () => {
  it('creates a tenant on first sight and returns its id', async () => {
    const id = await service.findOrCreate({ workosUserId: 'u1', workosOrgId: 'o1', email: 'a@b.com' });
    expect(id).toBe('t1');
    expect(repo.createCalls).toBe(1);
  });

  it('returns the same tenant id on subsequent calls (no duplicate)', async () => {
    const first = await service.findOrCreate({ workosUserId: 'u1', workosOrgId: 'o1', email: 'a@b.com' });
    const second = await service.findOrCreate({ workosUserId: 'u1', workosOrgId: 'o1', email: 'a@b.com' });
    expect(second).toBe(first);
    expect(repo.createCalls).toBe(1);
  });

  it('maps the same user in different orgs to different tenants', async () => {
    const a = await service.findOrCreate({ workosUserId: 'u1', workosOrgId: 'o1', email: 'a@b.com' });
    const b = await service.findOrCreate({ workosUserId: 'u1', workosOrgId: 'o2', email: 'a@b.com' });
    expect(a).not.toBe(b);
  });

  it('falls back to the user id as the org key when org is null, stably', async () => {
    const a = await service.findOrCreate({ workosUserId: 'u1', workosOrgId: null, email: 'a@b.com' });
    const b = await service.findOrCreate({ workosUserId: 'u1', workosOrgId: null, email: 'a@b.com' });
    expect(a).toBe(b);
    expect(repo.rows[0].workosOrgId).toBe('u1');
  });
});
