export const KANBAN_STORE_API_VERSION = 'kanban-store.v1' as const

export type KanbanStoreApiVersion = typeof KANBAN_STORE_API_VERSION

export const KANBAN_STORE_CAPABILITIES = [
  'boards',
  'tasks',
  'taskLinks',
  'comments',
  'events',
  'runs',
  'claims',
  'dispatcher',
  'workspaces',
  'notifications',
  'stats',
  'diagnostics',
  'idempotentCreate',
  'skillValidation',
  'completionCreatedCardsGuard',
] as const

export type KanbanStoreCapability = (typeof KANBAN_STORE_CAPABILITIES)[number]
export type KanbanStoreCapabilityMap = Record<KanbanStoreCapability, boolean>

export type KanbanTaskStatus =
  | 'triage'
  | 'todo'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'done'
  | 'archived'
export type KanbanWorkspaceKind = 'scratch' | 'dir' | 'worktree'

export type KanbanBoardRef = {
  slug: string
  path?: string | null
  current?: boolean
}

export type KanbanTaskRecord = {
  id: string
  title: string
  body?: string | null
  assignee?: string | null
  status: KanbanTaskStatus | string
  priority?: number | null
  createdBy?: string | null
  createdAt?: number | string | null
  updatedAt?: number | string | null
  startedAt?: number | string | null
  completedAt?: number | string | null
  workspaceKind?: KanbanWorkspaceKind | string | null
  workspacePath?: string | null
  tenant?: string | null
  result?: string | null
  idempotencyKey?: string | null
  currentRunId?: number | string | null
  skills?: string[] | null
  maxRetries?: number | null
  maxRuntimeSeconds?: number | null
}

export type KanbanTaskLink = {
  parentId: string
  childId: string
}

export type KanbanTaskComment = {
  id?: number | string
  taskId: string
  body: string
  author?: string | null
  createdAt?: number | string | null
}

export type KanbanTaskEvent = {
  id?: number | string
  taskId: string
  runId?: number | string | null
  kind: string
  payload?: unknown
  createdAt?: number | string | null
}

export type KanbanTaskRun = {
  id: number | string
  taskId: string
  profile?: string | null
  status?: string | null
  outcome?: string | null
  summary?: string | null
  metadata?: unknown
  error?: string | null
  startedAt?: number | string | null
  endedAt?: number | string | null
  heartbeatAt?: number | string | null
}

export type KanbanNotifySubscription = {
  id?: number | string
  platform: string
  taskId?: string | null
  board?: string | null
  chatId?: string | null
  threadId?: string | null
  userId?: string | null
  lastEventId?: number | string | null
}

export type CreateKanbanTaskRequest = {
  title: string
  body?: string | null
  assignee?: string | null
  status?: KanbanTaskStatus | null
  priority?: number | null
  createdBy?: string | null
  parents?: string[]
  tenant?: string | null
  workspaceKind?: KanbanWorkspaceKind | null
  workspacePath?: string | null
  triage?: boolean
  idempotencyKey?: string | null
  maxRuntimeSeconds?: number | null
  maxRetries?: number | null
  skills?: string[]
}

export type UpdateKanbanTaskRequest = Partial<{
  title: string
  body: string | null
  assignee: string | null
  status: KanbanTaskStatus
  priority: number
  tenant: string | null
  result: string | null
  maxRuntimeSeconds: number | null
  maxRetries: number | null
  skills: string[]
}>

export type ClaimKanbanTaskRequest = {
  taskId: string
  profile: string
  claimLock?: string | null
  claimTtlSeconds?: number | null
  workerPid?: number | null
  maxRuntimeSeconds?: number | null
}

export type CompleteKanbanTaskRequest = {
  taskId: string
  summary?: string | null
  result?: string | null
  metadata?: unknown
  createdCards?: string[]
}

export type BlockKanbanTaskRequest = {
  taskId: string
  reason: string
}

export type KanbanStoreProviderMetadata = {
  providerId: string
  label: string
  apiVersion: KanbanStoreApiVersion
  capabilities: KanbanStoreCapabilityMap
  detected: boolean
  writable: boolean
  storageAuthority:
    | 'local-file'
    | 'sqlite'
    | 'dashboard-proxy'
    | 'postgres'
    | 'remote'
    | 'memory'
    | string
  details?: string | null
  path?: string | null
}

export type MaybePromise<T> = T | Promise<T>

export interface KanbanStoreProvider {
  metadata(): MaybePromise<KanbanStoreProviderMetadata>

  listBoards(): MaybePromise<KanbanBoardRef[]>
  createBoard(slug: string): MaybePromise<KanbanBoardRef>
  renameBoard(oldSlug: string, newSlug: string): MaybePromise<KanbanBoardRef>
  deleteBoard(slug: string): MaybePromise<void>
  switchBoard(slug: string): MaybePromise<KanbanBoardRef>

  listTasks(filters?: Record<string, unknown>): MaybePromise<KanbanTaskRecord[]>
  getTask(taskId: string): MaybePromise<KanbanTaskRecord | null>
  createTask(input: CreateKanbanTaskRequest): MaybePromise<KanbanTaskRecord>
  updateTask(
    taskId: string,
    updates: UpdateKanbanTaskRequest,
  ): MaybePromise<KanbanTaskRecord | null>
  archiveTask(taskId: string): MaybePromise<KanbanTaskRecord | null>

  listLinks(taskId?: string): MaybePromise<KanbanTaskLink[]>
  linkTasks(parentId: string, childId: string): MaybePromise<KanbanTaskLink>
  unlinkTasks(parentId: string, childId: string): MaybePromise<void>

  listComments(taskId: string): MaybePromise<KanbanTaskComment[]>
  addComment(taskId: string, body: string): MaybePromise<KanbanTaskComment>

  listEvents(
    taskId?: string,
    afterEventId?: number | string | null,
  ): MaybePromise<KanbanTaskEvent[]>
  appendEvent(
    taskId: string,
    kind: string,
    payload?: unknown,
  ): MaybePromise<KanbanTaskEvent>

  claimTask(input: ClaimKanbanTaskRequest): MaybePromise<KanbanTaskRun>
  heartbeatTask(
    taskId: string,
    note?: string | null,
  ): MaybePromise<KanbanTaskRun | null>
  completeTask(input: CompleteKanbanTaskRequest): MaybePromise<KanbanTaskRecord>
  blockTask(input: BlockKanbanTaskRequest): MaybePromise<KanbanTaskRecord>
  unblockTask(taskId: string): MaybePromise<KanbanTaskRecord>
  reclaimTask(taskId: string): MaybePromise<KanbanTaskRecord | null>

  listRuns(taskId?: string): MaybePromise<KanbanTaskRun[]>
  readTaskLog(
    taskId: string,
    offset?: number,
    limit?: number,
  ): MaybePromise<string>

  listNotifySubscriptions(): MaybePromise<KanbanNotifySubscription[]>
  upsertNotifySubscription(
    subscription: KanbanNotifySubscription,
  ): MaybePromise<KanbanNotifySubscription>
  deleteNotifySubscription(subscriptionId: number | string): MaybePromise<void>

  stats(): MaybePromise<Record<string, unknown>>
  diagnostics(): MaybePromise<Record<string, unknown>>
}

export function kanbanStoreCapabilities(
  supported: Partial<Record<KanbanStoreCapability, boolean>> = {},
): KanbanStoreCapabilityMap {
  return Object.fromEntries(
    KANBAN_STORE_CAPABILITIES.map((capability) => [
      capability,
      supported[capability] === true,
    ]),
  ) as KanbanStoreCapabilityMap
}

export function validateKanbanStoreProviderMetadata(
  metadata: KanbanStoreProviderMetadata,
): KanbanStoreProviderMetadata {
  if (metadata.apiVersion !== KANBAN_STORE_API_VERSION) {
    throw new Error(
      `Unsupported KanbanStore apiVersion: ${metadata.apiVersion}`,
    )
  }
  for (const capability of KANBAN_STORE_CAPABILITIES) {
    if (typeof metadata.capabilities[capability] !== 'boolean') {
      throw new Error(
        `KanbanStore capability ${capability} must be declared as a boolean`,
      )
    }
  }
  return metadata
}
