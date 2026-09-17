import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticateAgent, listAgents, registerLocalAgent } from './agent-pairing.service.js';

/**
 * Pairing tests.
 *
 * `query` is mocked so these run without a database: what is under test is the
 * SQL the service issues and how it interprets the rows it gets back, which is
 * where the local-agent (NULL owner) path can go wrong. A real database would
 * not catch a wrong `owner_user_id` predicate — these do.
 */
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('../db/pool.js', () => ({
  query: queryMock,
  queryOne: vi.fn(),
}));

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const OWNER_ID = '99999999-8888-4777-8666-555555555555';
const TOKEN = 'aether-agent_test-token-value';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function lastQuery(): { sql: string; params: unknown[] } {
  const call = queryMock.mock.calls.at(-1);
  expect(call).toBeDefined();
  return { sql: String(call?.[0]), params: (call?.[1] ?? []) as unknown[] };
}

beforeEach(() => {
  queryMock.mockReset();
});

describe('registerLocalAgent', () => {
  it('stores the hash it is given, with no owner and scope=local', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });

    await registerLocalAgent({
      agentId: AGENT_ID,
      label: 'Local host',
      tokenHash: sha256Hex(TOKEN),
    });

    const { sql, params } = lastQuery();
    expect(sql).toContain('INSERT INTO aether.host_agents');
    expect(sql).toContain("'local'");
    expect(sql).toContain('owner_user_id');
    expect(sql).toContain('NULL');
    expect(params).toEqual([AGENT_ID, 'Local host', sha256Hex(TOKEN)]);
  });

  it('upserts instead of failing on a re-run, and clears a revocation', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });

    await registerLocalAgent({
      agentId: AGENT_ID,
      label: 'Local host',
      tokenHash: sha256Hex(TOKEN),
    });

    const { sql } = lastQuery();
    expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
    expect(sql).toContain('token_hash    = EXCLUDED.token_hash');
    expect(sql).toContain('revoked_at    = NULL');
  });

  it('never receives the plaintext token', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });

    const tokenHash = sha256Hex(TOKEN);
    await registerLocalAgent({ agentId: AGENT_ID, label: 'Local host', tokenHash });

    const { sql, params } = lastQuery();
    expect(params).not.toContain(TOKEN);
    expect(sql).not.toContain(TOKEN);
    expect(String(params[2])).toHaveLength(64);
  });
});

describe('authenticateAgent', () => {
  const row = {
    id: AGENT_ID,
    label: 'Local host',
    token_hash: sha256Hex(TOKEN),
    owner_user_id: null,
    created_at: new Date().toISOString(),
    revoked_at: null,
  };

  it('authenticates an instance-scoped agent and reports no owner', async () => {
    queryMock.mockResolvedValue({ rows: [row], rowCount: 1 });

    const record = await authenticateAgent(AGENT_ID, TOKEN);

    expect(record.agentId).toBe(AGENT_ID);
    expect(record.ownerUserId).toBeNull();
  });

  it('rejects a wrong token', async () => {
    queryMock.mockResolvedValue({ rows: [row], rowCount: 1 });

    await expect(authenticateAgent(AGENT_ID, 'aether-agent_wrong')).rejects.toThrow(
      /Invalid agent token/
    );
  });

  it('rejects an unknown agent', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(authenticateAgent(AGENT_ID, TOKEN)).rejects.toThrow(/Unknown agent/);
  });

  it('rejects a revoked agent', async () => {
    queryMock.mockResolvedValue({
      rows: [{ ...row, revoked_at: new Date().toISOString() }],
      rowCount: 1,
    });

    await expect(authenticateAgent(AGENT_ID, TOKEN)).rejects.toThrow(/revoked/);
  });
});

describe('listAgents', () => {
  it('includes instance-scoped agents for every owner', async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          id: AGENT_ID,
          label: 'Local host',
          owner_user_id: null,
          created_at: new Date().toISOString(),
        },
      ],
      rowCount: 1,
    });

    const agents = await listAgents(OWNER_ID);

    const { sql, params } = lastQuery();
    expect(sql).toContain('owner_user_id IS NULL');
    expect(params).toEqual([OWNER_ID]);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.ownerUserId).toBeNull();
  });
});
