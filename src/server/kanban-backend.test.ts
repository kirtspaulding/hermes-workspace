import { afterEach, describe, expect, it, vi } from 'vitest'
import { KANBAN_STORE_API_VERSION } from './kanban-store-contract'

afterEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

async function loadKanbanBackend(options?: {
  existsSync?: (path: string) => boolean
  readFileSync?: (path: string) => string
  execFileSync?: (command: string, args?: string[]) => string
}) {
  vi.doMock('./swarm-kanban-store', () => ({
    SWARM_KANBAN_FILE: '/tmp/swarm2-kanban.json',
    createSwarmKanbanCard: vi.fn((input) => ({
      id: 'local-1',
      title: input.title,
      spec: input.spec ?? '',
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      assignedWorker: input.assignedWorker ?? null,
      reviewer: input.reviewer ?? null,
      status: input.status ?? 'backlog',
      missionId: input.missionId ?? null,
      reportPath: input.reportPath ?? null,
      createdBy: input.createdBy ?? 'swarm2-kanban',
      createdAt: 1,
      updatedAt: 1,
    })),
    listSwarmKanbanCards: vi.fn(() => [
      {
        id: 'local-1',
        title: 'Local task',
        spec: '',
        acceptanceCriteria: [],
        assignedWorker: null,
        reviewer: null,
        status: 'backlog',
        missionId: null,
        reportPath: null,
        createdBy: 'local',
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
    updateSwarmKanbanCard: vi.fn((cardId, updates) => ({
      id: cardId,
      title: updates.title ?? 'Local task',
      spec: updates.spec ?? '',
      acceptanceCriteria: [],
      assignedWorker: updates.assignedWorker ?? null,
      reviewer: null,
      status: updates.status ?? 'backlog',
      missionId: null,
      reportPath: null,
      createdBy: 'local',
      createdAt: 1,
      updatedAt: 2,
    })),
  }))

  vi.doMock('node:fs', () => ({
    existsSync: vi.fn((path: string) => options?.existsSync?.(path) ?? false),
    readFileSync: vi.fn((path: string) => options?.readFileSync?.(path) ?? ''),
  }))

  vi.doMock('node:child_process', () => ({
    execFileSync: vi.fn(
      (command: string, args?: string[]) =>
        options?.execFileSync?.(command, args) ?? '',
    ),
  }))

  return import('./kanban-backend')
}

describe('kanban-backend', () => {
  it('auto-detect prefers Hermes backend when Hermes CLI and canonical storage are present', async () => {
    vi.stubEnv('HERMES_KANBAN_STORE_PROVIDER', 'sqlite')
    vi.stubEnv('CLAUDE_HOME', '/Users/aurora/.claude/profiles/swarm2')
    vi.stubEnv('HERMES_HOME', '/Users/aurora/.claude/profiles/swarm2')
    const sqliteCalls: Array<{ command: string; args?: string[] }> = []
    const mod = await loadKanbanBackend({
      existsSync: (target) =>
        target === '/Users/aurora/.claude/kanban.db' ||
        target === '/Users/aurora/.claude/kanban',
      execFileSync: (command, args = []) => {
        if (command === 'which' && args[0] === 'claude')
          return '/Users/aurora/.local/bin/claude\n'
        if (
          command === '/Users/aurora/.local/bin/claude' &&
          args[0] === '--version'
        )
          return 'claude 1.0.0\n'
        if (command === 'sqlite3') {
          sqliteCalls.push({ command, args })
          return JSON.stringify([
            {
              id: 't_12345678',
              title: 'Hermes task',
              body: 'Backed by sqlite',
              status: 'running',
              assignee: 'swarm2',
              created_at: 1777527540,
              updated_at: 1777527644,
            },
          ])
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
      },
    })

    expect(mod.getKanbanBackendMeta()).toMatchObject({
      id: 'claude',
      detected: true,
      writable: true,
      path: '/Users/aurora/.claude/kanban.db',
      apiVersion: KANBAN_STORE_API_VERSION,
      capabilities: {
        tasks: true,
        runs: false,
        claims: false,
        dispatcher: false,
        completionCreatedCardsGuard: false,
      },
    })

    const cards = await mod.listKanbanCards()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      id: 't_12345678',
      title: 'Hermes task',
      status: 'running',
      assignedWorker: 'swarm2',
      createdBy: 'claude-kanban',
    })
    expect(sqliteCalls[0]?.args?.[0]).toBe('/Users/aurora/.claude/kanban.db')
  })

  it('auto-detect uses Hermes storage directly when the CLI is unavailable', async () => {
    vi.stubEnv('HERMES_KANBAN_STORE_PROVIDER', 'sqlite')
    vi.stubEnv('CLAUDE_HOME', '/Users/aurora/.claude/profiles/swarm2')
    vi.stubEnv('HERMES_HOME', '/Users/aurora/.claude/profiles/swarm2')
    const mod = await loadKanbanBackend({
      existsSync: (target) => target === '/Users/aurora/.claude/kanban.db',
      execFileSync: (command, args = []) => {
        if (command === 'which' && args[0] === 'claude')
          throw new Error('not found')
        if (command === 'sqlite3') {
          return JSON.stringify([
            {
              id: 't_direct',
              title: 'Direct Hermes task',
              body: '',
              status: 'ready',
              assignee: null,
              created_at: 1777527540,
              updated_at: 1777527644,
            },
          ])
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
      },
    })

    expect(mod.getKanbanBackendMeta()).toMatchObject({
      id: 'claude',
      detected: true,
      writable: true,
      path: '/Users/aurora/.claude/kanban.db',
    })
    expect(mod.getKanbanBackendMeta().details).toContain(
      'direct local storage access',
    )
    expect((await mod.listKanbanCards())[0]).toMatchObject({
      id: 't_direct',
      status: 'ready',
    })
  })

  it('resolves canonical Kanban paths from legacy profile-home env fallback too', async () => {
    vi.stubEnv('HERMES_KANBAN_STORE_PROVIDER', 'sqlite')
    vi.stubEnv('CLAUDE_HOME', '/Users/aurora/.claude/profiles/swarm5/home')
    vi.stubEnv('HERMES_HOME', '/Users/aurora/.claude/profiles/swarm5/home')
    const mod = await loadKanbanBackend({
      existsSync: (target) => target === '/Users/aurora/.claude/kanban.db',
      execFileSync: (command, args = []) => {
        if (command === 'which' && args[0] === 'claude')
          throw new Error('not found')
        if (command === 'sqlite3') return '[]'
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
      },
    })

    expect(mod.getKanbanBackendMeta()).toMatchObject({
      id: 'claude',
      detected: true,
      path: '/Users/aurora/.claude/kanban.db',
    })
  })

  it('auto-detect falls back to local when canonical Hermes storage is missing', async () => {
    vi.stubEnv('HERMES_KANBAN_STORE_PROVIDER', 'sqlite')
    vi.stubEnv('CLAUDE_HOME', '/Users/aurora/.claude/profiles/swarm2')
    vi.stubEnv('HERMES_HOME', '/Users/aurora/.claude/profiles/swarm2')
    const mod = await loadKanbanBackend({
      existsSync: () => false,
      execFileSync: (command, args = []) => {
        if (command === 'which' && args[0] === 'claude')
          return '/Users/aurora/.local/bin/claude\n'
        if (
          command === '/Users/aurora/.local/bin/claude' &&
          args[0] === '--version'
        )
          return 'claude 1.0.0\n'
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
      },
    })

    expect(mod.getKanbanBackendMeta()).toMatchObject({
      id: 'local',
      detected: true,
      writable: true,
      path: '/tmp/swarm2-kanban.json',
      apiVersion: KANBAN_STORE_API_VERSION,
      capabilities: {
        tasks: true,
        runs: false,
        claims: false,
      },
    })
    expect((await mod.listKanbanCards())[0]?.id).toBe('local-1')
  })

  it('uses env provider selection and keeps sqlite as the default provider', async () => {
    vi.stubEnv('CLAUDE_HOME', '/Users/aurora/.claude/profiles/swarm2')
    vi.stubEnv('HERMES_HOME', '/Users/aurora/.claude/profiles/swarm2')
    vi.stubEnv('HERMES_KANBAN_STORE_PROVIDER', 'local')
    const mod = await loadKanbanBackend({
      existsSync: (target) =>
        target === '/Users/aurora/.claude/kanban.db' ||
        target === '/Users/aurora/.claude/kanban',
      execFileSync: (command, args = []) => {
        if (command === 'which' && args[0] === 'claude')
          return '/Users/aurora/.local/bin/claude\n'
        if (
          command === '/Users/aurora/.local/bin/claude' &&
          args[0] === '--version'
        )
          return 'claude 1.0.0\n'
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
      },
    })

    expect(mod.getKanbanBackendMeta()).toMatchObject({
      id: 'local',
      path: '/tmp/swarm2-kanban.json',
    })
  })

  it('uses config provider selection when env does not override it', async () => {
    vi.stubEnv('CLAUDE_HOME', '/Users/aurora/.claude/profiles/swarm2')
    vi.stubEnv('HERMES_HOME', '/Users/aurora/.claude/profiles/swarm2')
    const mod = await loadKanbanBackend({
      existsSync: (target) =>
        target === '/Users/aurora/.claude/config.yaml' ||
        target === '/Users/aurora/.claude/kanban.db',
      readFileSync: (target) => {
        expect(target).toBe('/Users/aurora/.claude/config.yaml')
        return 'kanban:\n  provider: local\n  api_version: kanban-store.v1\n'
      },
      execFileSync: (command, args = []) => {
        if (command === 'which' && args[0] === 'claude')
          throw new Error('not found')
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
      },
    })

    expect(mod.getKanbanBackendMeta()).toMatchObject({
      id: 'local',
      path: '/tmp/swarm2-kanban.json',
    })
  })

  it('uses CrossCut Postgres visual-board projection as a read-only provider', async () => {
    vi.stubEnv('HERMES_KANBAN_STORE_PROVIDER', 'crosscut-postgres')
    const crosscutCalls: string[][] = []
    const mod = await loadKanbanBackend({
      execFileSync: (command, args = []) => {
        if (command === 'crosscut') {
          crosscutCalls.push(args)
          if (args.includes('boards')) {
            return JSON.stringify({
              provider_id: 'crosscut-postgres',
              read_only: true,
              boards: [
                {
                  id: 'hermes-local:work-graph-execution',
                  backend_id: 'hermes-local',
                  external_board: 'work-graph-execution',
                  task_count: 1,
                },
              ],
            })
          }
          if (args.includes('tasks')) {
            return JSON.stringify({
              provider_id: 'crosscut-postgres',
              read_only: true,
              tasks: [
                {
                  id: 'map-1',
                  title: 'CrossCut Work Item',
                  body: 'Durable planning body',
                  work_status: 'delegated',
                  external_status: 'running',
                  assignee_hint: 'crosscut-coder',
                  priority: 7,
                },
              ],
            })
          }
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
      },
    })

    expect(mod.getKanbanBackendMeta()).toMatchObject({
      id: 'crosscut-postgres',
      detected: true,
      writable: false,
      path: 'crosscut work visual-board',
      capabilities: {
        boards: true,
        tasks: true,
        taskLinks: false,
        comments: false,
        events: false,
        runs: false,
        claims: false,
        dispatcher: false,
        notifications: false,
        idempotentCreate: false,
        skillValidation: false,
        completionCreatedCardsGuard: false,
      },
    })
    const cards = await mod.listKanbanCards()
    expect(cards[0]).toMatchObject({
      id: 'map-1',
      title: 'CrossCut Work Item',
      spec: expect.stringContaining('Durable planning body'),
      assignedWorker: 'crosscut-coder',
      status: 'ready',
      createdBy: 'crosscut-postgres',
    })
    await expect(
      mod.createKanbanCard({ title: 'nope', spec: '', status: 'ready' }),
    ).rejects.toThrow(/read-only/)
    expect(crosscutCalls.some((args) => args.includes('boards'))).toBe(true)
    expect(crosscutCalls.some((args) => args.includes('tasks'))).toBe(true)
  })

  it('falls back when CrossCut Postgres provider is selected but unavailable', async () => {
    vi.stubEnv('HERMES_KANBAN_STORE_PROVIDER', 'crosscut-postgres')
    const mod = await loadKanbanBackend({
      execFileSync: (command, args = []) => {
        if (command === 'crosscut') throw new Error('database unavailable')
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
      },
    })

    expect(mod.getKanbanBackendMeta()).toMatchObject({
      id: 'local',
      detected: true,
      writable: true,
    })
    expect((await mod.listKanbanCards())[0]?.id).toBe('local-1')
  })

  it('fails loudly for unsupported env providers and API versions', async () => {
    vi.stubEnv('HERMES_KANBAN_STORE_PROVIDER', 'postgres')
    const unsupportedProvider = await loadKanbanBackend()
    expect(() => unsupportedProvider.getKanbanBackendMeta()).toThrow(
      /Unsupported Kanban provider/,
    )

    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('HERMES_KANBAN_STORE_API_VERSION', 'kanban-store.v2')
    const unsupportedApi = await loadKanbanBackend()
    expect(() => unsupportedApi.getKanbanBackendMeta()).toThrow(
      /Unsupported Kanban store API version/,
    )
  })

  it('creates and updates Hermes tasks through canonical kanban.db path', async () => {
    vi.stubEnv('HERMES_KANBAN_STORE_PROVIDER', 'sqlite')
    vi.stubEnv('CLAUDE_HOME', '/Users/aurora/.claude/profiles/swarm2')
    vi.stubEnv('HERMES_HOME', '/Users/aurora/.claude/profiles/swarm2')
    const sqliteCalls: string[] = []
    let readCount = 0
    const mod = await loadKanbanBackend({
      existsSync: (target) =>
        target === '/Users/aurora/.claude/kanban.db' ||
        target === '/Users/aurora/.claude/kanban',
      execFileSync: (command, args = []) => {
        if (command === 'which' && args[0] === 'claude')
          return '/Users/aurora/.local/bin/claude\n'
        if (
          command === '/Users/aurora/.local/bin/claude' &&
          args[0] === '--version'
        )
          return 'claude 1.0.0\n'
        if (command === 'sqlite3') {
          sqliteCalls.push(args.join(' '))
          const sql = args[2] ?? ''
          if (sql.includes('where id =')) {
            readCount += 1
            return JSON.stringify([
              {
                id: 't_deadbeef',
                title:
                  readCount === 1
                    ? 'Created Hermes task'
                    : 'Updated Hermes task',
                body: 'Task body',
                status: readCount === 1 ? 'queued' : 'done',
                assignee: 'swarm6',
                created_at: 1777527540,
                updated_at: 1777527644,
              },
            ])
          }
          return '[]'
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
      },
    })

    const created = await mod.createKanbanCard({
      title: 'Created Hermes task',
      spec: 'Task body',
      assignedWorker: 'swarm6',
      status: 'backlog',
    })
    const updated = await mod.updateKanbanCard('t_deadbeef', {
      title: 'Updated Hermes task',
      status: 'done',
      assignedWorker: 'swarm6',
    })

    expect(created).toMatchObject({
      id: 't_deadbeef',
      title: 'Created Hermes task',
      status: 'backlog',
      assignedWorker: 'swarm6',
      createdBy: 'claude-kanban',
    })
    expect(updated).toMatchObject({
      id: 't_deadbeef',
      title: 'Updated Hermes task',
      status: 'done',
      assignedWorker: 'swarm6',
    })
    expect(
      sqliteCalls.every((call) =>
        call.startsWith('/Users/aurora/.claude/kanban.db '),
      ),
    ).toBe(true)
    expect(sqliteCalls.some((call) => call.includes('insert into tasks'))).toBe(
      true,
    )
    expect(sqliteCalls.some((call) => call.includes('update tasks set'))).toBe(
      true,
    )
  })
})
