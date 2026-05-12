import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'

import {
  KANBAN_STORE_API_VERSION,
  kanbanStoreCapabilities,
  validateKanbanStoreProviderMetadata,
  type BlockKanbanTaskRequest,
  type ClaimKanbanTaskRequest,
  type CompleteKanbanTaskRequest,
  type CreateKanbanTaskRequest,
  type KanbanBoardRef,
  type KanbanNotifySubscription,
  type KanbanStoreCapabilityMap,
  type KanbanStoreProvider,
  type KanbanStoreProviderMetadata,
  type KanbanTaskComment,
  type KanbanTaskEvent,
  type KanbanTaskLink,
  type KanbanTaskRecord,
  type KanbanTaskRun,
  type UpdateKanbanTaskRequest,
} from './kanban-store-contract'

export type SqliteKanbanTaskRow = {
  id: string
  title: string
  body?: string | null
  status?: string | null
  assignee?: string | null
  created_at?: number | string | null
  started_at?: number | string | null
  completed_at?: number | string | null
  updated_at?: number | string | null
}

export type SqliteKanbanProviderOptions = {
  providerId?: string
  label?: string
  detected: boolean
  writable?: boolean
  dbPath: string
  workspacePath: string
  details?: string | null
  cliPath?: string | null
  capabilities?: KanbanStoreCapabilityMap
}

export const HERMES_SQLITE_KANBAN_CAPABILITIES = kanbanStoreCapabilities({
  boards: true,
  tasks: true,
  stats: true,
  diagnostics: true,
})

export function sqliteQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function runSqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath, '-json', sql], {
    encoding: 'utf8',
    timeout: 15_000,
  }).trim()
}

function parseSqliteRows<T>(raw: string): T[] {
  const parsed = raw ? (JSON.parse(raw) as T[]) : []
  return Array.isArray(parsed) ? parsed : []
}

function normalizeStatus(
  status: string | null | undefined,
): KanbanTaskRecord['status'] {
  switch ((status ?? '').toLowerCase()) {
    case 'queued':
      return 'todo'
    case 'triage':
    case 'todo':
    case 'ready':
    case 'running':
    case 'blocked':
    case 'done':
    case 'archived':
      return status?.toLowerCase() ?? 'todo'
    case 'complete':
    case 'completed':
      return 'done'
    default:
      return 'todo'
  }
}

function mapContractStatusToSqlite(status: string | null | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'todo':
      return 'queued'
    case 'triage':
    case 'ready':
    case 'running':
    case 'blocked':
    case 'done':
    case 'archived':
      return status?.toLowerCase() ?? 'queued'
    default:
      return 'queued'
  }
}

function rowToTask(row: SqliteKanbanTaskRow): KanbanTaskRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body ?? '',
    status: normalizeStatus(row.status),
    assignee: row.assignee ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  }
}

function unsupported(operation: string): never {
  throw new Error(
    `Hermes SQLite Kanban provider does not implement ${operation}`,
  )
}

export class SqliteKanbanStoreProvider implements KanbanStoreProvider {
  private readonly options: Required<
    Pick<SqliteKanbanProviderOptions, 'providerId' | 'label'>
  > &
    Omit<SqliteKanbanProviderOptions, 'providerId' | 'label'>

  constructor(options: SqliteKanbanProviderOptions) {
    this.options = {
      providerId: options.providerId ?? 'hermes-sqlite',
      label: options.label ?? 'Hermes Kanban SQLite',
      ...options,
    }
  }

  metadata(): KanbanStoreProviderMetadata {
    return validateKanbanStoreProviderMetadata({
      providerId: this.options.providerId,
      label: this.options.label,
      apiVersion: KANBAN_STORE_API_VERSION,
      capabilities:
        this.options.capabilities ?? HERMES_SQLITE_KANBAN_CAPABILITIES,
      detected: this.options.detected,
      writable: this.options.writable ?? this.options.detected,
      storageAuthority: 'sqlite',
      details: this.options.details ?? null,
      path: this.options.detected ? this.options.dbPath : null,
    })
  }

  listBoards(): KanbanBoardRef[] {
    return [
      {
        slug: 'default',
        path: this.options.workspacePath,
        current: true,
      },
    ]
  }

  createBoard(_slug: string): KanbanBoardRef {
    return unsupported('createBoard')
  }

  renameBoard(_oldSlug: string, _newSlug: string): KanbanBoardRef {
    return unsupported('renameBoard')
  }

  deleteBoard(_slug: string): void {
    unsupported('deleteBoard')
  }

  switchBoard(slug: string): KanbanBoardRef {
    if (slug !== 'default') return unsupported('switchBoard')
    return this.listBoards()[0]
  }

  listTasks(): KanbanTaskRecord[] {
    if (!this.options.detected) return []
    const raw = runSqlite(
      this.options.dbPath,
      [
        'select',
        'id,',
        'title,',
        'body,',
        'status,',
        'assignee,',
        'created_at,',
        'started_at,',
        'completed_at,',
        'coalesce(last_heartbeat_at, completed_at, started_at, created_at) as updated_at',
        'from tasks',
        'order by created_at desc, id desc;',
      ].join(' '),
    )
    return parseSqliteRows<SqliteKanbanTaskRow>(raw).map(rowToTask)
  }

  getTask(taskId: string): KanbanTaskRecord | null {
    if (!this.options.detected) return null
    const raw = runSqlite(
      this.options.dbPath,
      `select id, title, body, status, assignee, created_at, started_at, completed_at, coalesce(last_heartbeat_at, completed_at, started_at, created_at) as updated_at from tasks where id = ${sqliteQuote(taskId)} limit 1;`,
    )
    return parseSqliteRows<SqliteKanbanTaskRow>(raw).map(rowToTask)[0] ?? null
  }

  createTask(input: CreateKanbanTaskRequest): KanbanTaskRecord {
    if (!this.options.detected)
      throw new Error('Hermes Kanban SQLite storage not detected')
    const nowSeconds = Math.floor(Date.now() / 1000)
    const taskId = `t_${randomUUID().replace(/-/g, '').slice(0, 8)}`
    const status = mapContractStatusToSqlite(input.status ?? 'todo')
    const statements = [
      'insert into tasks (',
      'id, title, body, assignee, status, priority, created_by, created_at, workspace_kind, workspace_path',
      ') values (',
      [
        sqliteQuote(taskId),
        sqliteQuote(input.title.trim()),
        sqliteQuote((input.body ?? '').trim()),
        input.assignee?.trim() ? sqliteQuote(input.assignee.trim()) : 'NULL',
        sqliteQuote(status),
        String(input.priority ?? 0),
        sqliteQuote(input.createdBy?.trim() || 'hermes-workspace'),
        String(nowSeconds),
        sqliteQuote(input.workspaceKind ?? 'scratch'),
        sqliteQuote(
          input.workspacePath?.trim() ||
            path.join(this.options.workspacePath, 'workspaces', taskId),
        ),
      ].join(', '),
      ');',
    ].join(' ')
    runSqlite(this.options.dbPath, statements)
    const created = this.getTask(taskId)
    if (!created)
      throw new Error(
        `Created Hermes task ${taskId} but could not read it back`,
      )
    return created
  }

  updateTask(
    taskId: string,
    updates: UpdateKanbanTaskRequest,
  ): KanbanTaskRecord | null {
    if (!this.options.detected) return null
    const assignments: string[] = []
    if (typeof updates.title === 'string' && updates.title.trim()) {
      assignments.push(`title = ${sqliteQuote(updates.title.trim())}`)
    }
    if (typeof updates.body === 'string') {
      assignments.push(`body = ${sqliteQuote(updates.body)}`)
    }
    if (updates.assignee !== undefined) {
      assignments.push(
        `assignee = ${updates.assignee?.trim() ? sqliteQuote(updates.assignee.trim()) : 'NULL'}`,
      )
    }
    if (updates.status) {
      const status = mapContractStatusToSqlite(updates.status)
      assignments.push(`status = ${sqliteQuote(status)}`)
      if (status === 'running') {
        assignments.push(
          `started_at = coalesce(started_at, ${Math.floor(Date.now() / 1000)})`,
        )
      }
      if (status === 'done')
        assignments.push(`completed_at = ${Math.floor(Date.now() / 1000)}`)
      if (status !== 'done') assignments.push('completed_at = NULL')
    }
    if (assignments.length === 0) return this.getTask(taskId)
    runSqlite(
      this.options.dbPath,
      `update tasks set ${assignments.join(', ')} where id = ${sqliteQuote(taskId)};`,
    )
    return this.getTask(taskId)
  }

  archiveTask(taskId: string): KanbanTaskRecord | null {
    return this.updateTask(taskId, { status: 'archived' })
  }

  listLinks(_taskId?: string): KanbanTaskLink[] {
    return unsupported('listLinks')
  }

  linkTasks(_parentId: string, _childId: string): KanbanTaskLink {
    return unsupported('linkTasks')
  }

  unlinkTasks(_parentId: string, _childId: string): void {
    unsupported('unlinkTasks')
  }

  listComments(_taskId: string): KanbanTaskComment[] {
    return unsupported('listComments')
  }

  addComment(_taskId: string, _body: string): KanbanTaskComment {
    return unsupported('addComment')
  }

  listEvents(
    _taskId?: string,
    _afterEventId?: number | string | null,
  ): KanbanTaskEvent[] {
    return unsupported('listEvents')
  }

  appendEvent(
    _taskId: string,
    _kind: string,
    _payload?: unknown,
  ): KanbanTaskEvent {
    return unsupported('appendEvent')
  }

  claimTask(_input: ClaimKanbanTaskRequest): KanbanTaskRun {
    return unsupported('claimTask')
  }

  heartbeatTask(_taskId: string, _note?: string | null): KanbanTaskRun | null {
    return unsupported('heartbeatTask')
  }

  completeTask(_input: CompleteKanbanTaskRequest): KanbanTaskRecord {
    return unsupported('completeTask')
  }

  blockTask(_input: BlockKanbanTaskRequest): KanbanTaskRecord {
    return unsupported('blockTask')
  }

  unblockTask(_taskId: string): KanbanTaskRecord {
    return unsupported('unblockTask')
  }

  reclaimTask(_taskId: string): KanbanTaskRecord | null {
    return unsupported('reclaimTask')
  }

  listRuns(_taskId?: string): KanbanTaskRun[] {
    return unsupported('listRuns')
  }

  readTaskLog(_taskId: string, _offset?: number, _limit?: number): string {
    return unsupported('readTaskLog')
  }

  listNotifySubscriptions(): KanbanNotifySubscription[] {
    return unsupported('listNotifySubscriptions')
  }

  upsertNotifySubscription(
    _subscription: KanbanNotifySubscription,
  ): KanbanNotifySubscription {
    return unsupported('upsertNotifySubscription')
  }

  deleteNotifySubscription(_subscriptionId: number | string): void {
    unsupported('deleteNotifySubscription')
  }

  stats(): Record<string, unknown> {
    return {
      providerId: this.options.providerId,
      detected: this.options.detected,
    }
  }

  diagnostics(): Record<string, unknown> {
    return {
      providerId: this.options.providerId,
      detected: this.options.detected,
      dbPath: this.options.dbPath,
      workspacePath: this.options.workspacePath,
      cliPath: this.options.cliPath ?? null,
    }
  }
}
