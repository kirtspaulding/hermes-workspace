import { afterEach, describe, expect, it, vi } from 'vitest'

import { KANBAN_STORE_API_VERSION } from './kanban-store-contract'
import { describeKanbanStoreProviderConformance } from './kanban-store-provider-conformance'

const execFileSync = vi.fn()

vi.mock('node:child_process', () => ({
  execFileSync,
}))

vi.mock('node:crypto', () => ({
  randomUUID: () => 'deadbeef-0000-4000-8000-000000000000',
}))

afterEach(() => {
  execFileSync.mockReset()
})

describe('SqliteKanbanStoreProvider', () => {
  it('advertises the KanbanStore contract with sqlite storage authority', async () => {
    const { SqliteKanbanStoreProvider } =
      await import('./kanban-sqlite-provider')
    const provider = new SqliteKanbanStoreProvider({
      providerId: 'claude',
      label: 'Hermes Kanban',
      detected: true,
      dbPath: '/tmp/kanban.db',
      workspacePath: '/tmp/kanban',
      details: 'direct sqlite',
    })

    expect(provider.metadata()).toMatchObject({
      providerId: 'claude',
      label: 'Hermes Kanban',
      apiVersion: KANBAN_STORE_API_VERSION,
      detected: true,
      writable: true,
      storageAuthority: 'sqlite',
      path: '/tmp/kanban.db',
      capabilities: {
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
  })

  it('routes task list/create/update through the provider sqlite adapter', async () => {
    const { SqliteKanbanStoreProvider } =
      await import('./kanban-sqlite-provider')
    const sqliteCalls: string[] = []
    let readCount = 0
    execFileSync.mockImplementation((_command: string, args: string[]) => {
      sqliteCalls.push(args.join(' '))
      const sql = args[2] ?? ''
      if (sql.includes('order by')) {
        return JSON.stringify([
          {
            id: 't_existing',
            title: 'Existing task',
            body: 'Body',
            status: 'running',
            assignee: 'worker-a',
            created_at: 1777527540,
          },
        ])
      }
      if (sql.includes('where id =')) {
        readCount += 1
        return JSON.stringify([
          {
            id: 't_deadbeef',
            title: readCount === 1 ? 'Created task' : 'Updated task',
            body: 'Body',
            status: readCount === 1 ? 'queued' : 'done',
            assignee: 'worker-b',
            created_at: 1777527540,
            completed_at: readCount === 1 ? null : 1777527644,
          },
        ])
      }
      return '[]'
    })

    const provider = new SqliteKanbanStoreProvider({
      detected: true,
      dbPath: '/tmp/kanban.db',
      workspacePath: '/tmp/kanban',
    })

    expect(provider.listTasks()[0]).toMatchObject({
      id: 't_existing',
      status: 'running',
      assignee: 'worker-a',
    })
    expect(
      provider.createTask({
        title: 'Created task',
        body: 'Body',
        assignee: 'worker-b',
        status: 'todo',
      }),
    ).toMatchObject({ id: 't_deadbeef', status: 'todo' })
    expect(
      provider.updateTask('t_deadbeef', {
        title: 'Updated task',
        status: 'done',
      }),
    ).toMatchObject({ id: 't_deadbeef', status: 'done' })

    expect(sqliteCalls.some((call) => call.includes('insert into tasks'))).toBe(
      true,
    )
    expect(sqliteCalls.some((call) => call.includes('update tasks set'))).toBe(
      true,
    )
  })
})

describeKanbanStoreProviderConformance({
  name: 'SqliteKanbanStoreProvider',
  createProvider: () => {
    type Row = {
      id: string
      title: string
      body: string
      status: string
      assignee: string | null
      created_at: number
      completed_at?: number | null
      workspace_kind?: string | null
      workspace_path?: string | null
    }

    const rows = new Map<string, Row>()
    const taskId = 't_deadbeef'
    execFileSync.mockImplementation((_command: string, args: string[]) => {
      const sql = args[2] ?? ''
      if (sql.includes('select') && sql.includes('where id =')) {
        const row = rows.get(taskId)
        return JSON.stringify(row ? [row] : [])
      }
      if (sql.includes('select') && sql.includes('order by')) {
        return JSON.stringify(Array.from(rows.values()))
      }
      if (sql.includes('insert into tasks')) {
        rows.set(taskId, {
          id: taskId,
          title: 'Conformance task',
          body: 'Created by shared KanbanStore conformance tests',
          status: 'queued',
          assignee: 'conformance-worker',
          created_at: 1777527540,
        })
        return '[]'
      }
      if (sql.includes('update tasks set')) {
        const existing = rows.get(taskId)
        if (existing) {
          if (sql.includes("title = 'Updated conformance task'")) {
            existing.title = 'Updated conformance task'
          }
          if (sql.includes("body = 'Updated body'")) {
            existing.body = 'Updated body'
          }
          if (sql.includes('assignee = NULL')) {
            existing.assignee = null
          }
          if (sql.includes("status = 'done'")) {
            existing.status = 'done'
            existing.completed_at = 1777527644
          }
          if (sql.includes("status = 'archived'")) {
            existing.status = 'archived'
            existing.completed_at = null
          }
        }
        return '[]'
      }
      return '[]'
    })

    return import('./kanban-sqlite-provider').then(
      ({ SqliteKanbanStoreProvider }) =>
        new SqliteKanbanStoreProvider({
          providerId: 'sqlite-conformance',
          label: 'SQLite conformance provider',
          detected: true,
          dbPath: '/tmp/kanban.db',
          workspacePath: '/tmp/kanban',
        }),
    )
  },
})
