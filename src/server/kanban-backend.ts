import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import YAML from 'yaml'
import { getClaudeRoot, getWorkspaceClaudeHome } from './claude-paths'
import {
  SWARM_KANBAN_FILE,
  type CreateSwarmKanbanCardInput,
  createSwarmKanbanCard,
  listSwarmKanbanCards,
  type SwarmKanbanCard,
  updateSwarmKanbanCard,
  type UpdateSwarmKanbanCardInput,
} from './swarm-kanban-store'
import { CLAUDE_DASHBOARD_URL, getCapabilities } from './gateway-capabilities'
import {
  fetchDashboardKanbanBoard,
  createDashboardKanbanTask,
  updateDashboardKanbanTask,
  type DashboardKanbanTask,
} from './kanban-dashboard-proxy'
import {
  HERMES_SQLITE_KANBAN_CAPABILITIES,
  SqliteKanbanStoreProvider,
} from './kanban-sqlite-provider'
import {
  KANBAN_STORE_API_VERSION,
  kanbanStoreCapabilities,
  type KanbanStoreApiVersion,
  type KanbanStoreCapabilityMap,
  type KanbanTaskRecord,
} from './kanban-store-contract'

export type KanbanBackendId = 'local' | 'claude' | 'hermes-proxy' | 'crosscut-postgres'

type KanbanProviderPreference = 'local' | 'sqlite' | 'hermes-proxy' | 'crosscut-postgres' | 'auto'

type KanbanProviderSelection = {
  provider: KanbanProviderPreference
  apiVersion: KanbanStoreApiVersion
}

export type KanbanBackendMeta = {
  id: KanbanBackendId
  label: string
  detected: boolean
  writable: boolean
  apiVersion: KanbanStoreApiVersion
  capabilities: KanbanStoreCapabilityMap
  details?: string | null
  path?: string | null
}

type KanbanBackend = {
  meta(): KanbanBackendMeta
  list(): SwarmKanbanCard[] | Promise<SwarmKanbanCard[]>
  create(
    input: CreateSwarmKanbanCardInput,
  ): SwarmKanbanCard | Promise<SwarmKanbanCard>
  update(
    cardId: string,
    updates: UpdateSwarmKanbanCardInput,
  ): SwarmKanbanCard | null | Promise<SwarmKanbanCard | null>
}

const BASIC_CARD_CAPABILITIES = kanbanStoreCapabilities({
  tasks: true,
})

const HERMES_KANBAN_CAPABILITIES = kanbanStoreCapabilities({
  boards: true,
  tasks: true,
  taskLinks: true,
  comments: true,
  events: true,
  runs: true,
  claims: true,
  dispatcher: true,
  workspaces: true,
  notifications: true,
  stats: true,
  diagnostics: true,
  idempotentCreate: true,
  skillValidation: true,
  completionCreatedCardsGuard: true,
})

function withKanbanStoreContract(
  meta: Omit<KanbanBackendMeta, 'apiVersion' | 'capabilities'>,
  capabilities: KanbanCapabilityPreset = BASIC_CARD_CAPABILITIES,
): KanbanBackendMeta {
  return {
    ...meta,
    apiVersion: KANBAN_STORE_API_VERSION,
    capabilities,
  }
}

type KanbanCapabilityPreset = KanbanStoreCapabilityMap

// Map upstream Hermes kanban statuses (triage/todo/ready/running/done/blocked
// and any custom user statuses) into our internal lane vocabulary. Mirrors
// mapClaudeStatus() but kept separate because the dashboard plugin sometimes
// returns slightly different status strings than direct SQL access.
function mapDashboardStatusToLane(
  status: string | null | undefined,
): SwarmKanbanCard['status'] {
  switch ((status ?? '').toLowerCase()) {
    case 'triage':
    case 'todo':
    case 'queued':
      return 'backlog'
    case 'ready':
      return 'ready'
    case 'running':
    case 'claimed':
    case 'in_progress':
      return 'running'
    case 'review':
      return 'review'
    case 'blocked':
      return 'blocked'
    case 'done':
    case 'complete':
    case 'completed':
      return 'done'
    default:
      return 'backlog'
  }
}

function mapLaneToDashboardStatus(lane: SwarmKanbanCard['status']): string {
  switch (lane) {
    case 'backlog':
      return 'todo'
    case 'ready':
      return 'ready'
    case 'running':
      // The Hermes dashboard rejects direct writes of 'running' — only the
      // dispatcher's claim path may move a task into 'running'. Treat a
      // user dragging a card to the running lane as 'mark it ready, let
      // the dispatcher pick it up'. The card will flip to running on the
      // next dispatcher tick (default 60s).
      return 'ready'
    case 'review':
      // 'review' isn't a first-class Hermes status; map to 'ready' so the
      // task remains visible on the board until a worker is assigned.
      return 'ready'
    case 'blocked':
      return 'blocked'
    case 'done':
      return 'done'
    default:
      return 'todo'
  }
}

function dashboardTaskToCard(task: DashboardKanbanTask): SwarmKanbanCard {
  const createdAt = normalizeTimestamp(task.created_at)
  const updatedAt = normalizeTimestamp(
    task.started_at ?? task.completed_at ?? task.created_at,
  )
  return {
    id: task.id,
    title: task.title,
    spec: task.body ?? '',
    acceptanceCriteria: [],
    assignedWorker: task.assignee ?? null,
    reviewer: null,
    status: mapDashboardStatusToLane(task.status),
    missionId: null,
    reportPath: null,
    createdBy: task.created_by ?? 'hermes-kanban',
    createdAt,
    updatedAt,
  }
}

type CrossCutVisualTask = {
  id?: string
  mapping_id?: string
  title?: string
  body?: string | null
  body_preview?: string | null
  work_status?: string | null
  external_status?: string | null
  assignee_hint?: string | null
  priority?: number | null
}

type CrossCutVisualTaskList = {
  tasks?: CrossCutVisualTask[]
}

type CrossCutVisualBoardList = {
  boards?: unknown[]
}

function runCrossCutVisualBoard(command: 'boards' | 'tasks'): unknown {
  const output = execFileSync(
    'crosscut',
    ['work', 'visual-board', command],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: process.env,
    },
  )
  return JSON.parse(output)
}

function detectCrossCutPostgres(): { available: boolean; reason?: string } {
  try {
    const boardList = runCrossCutVisualBoard('boards') as CrossCutVisualBoardList
    return { available: Array.isArray(boardList.boards) }
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

function mapCrossCutStatusToLane(status: string | null | undefined): SwarmKanbanCard['status'] {
  switch ((status ?? '').toLowerCase()) {
    case 'running':
      return 'running'
    case 'blocked':
      return 'blocked'
    case 'done':
      return 'done'
    case 'delegated':
    case 'ready':
      return 'ready'
    case 'planned':
    case 'backlog':
    case 'closed':
    default:
      return 'backlog'
  }
}

function crossCutTaskToCard(task: CrossCutVisualTask): SwarmKanbanCard {
  const body = task.body ?? task.body_preview ?? ''
  const externalStatus = task.external_status ? `\n\nExternal status: ${task.external_status}` : ''
  return {
    id: task.id ?? task.mapping_id ?? '',
    title: task.title ?? task.id ?? task.mapping_id ?? 'CrossCut Work Item',
    spec: `${body}${externalStatus}`,
    acceptanceCriteria: [],
    assignedWorker: task.assignee_hint ?? null,
    reviewer: null,
    status: mapCrossCutStatusToLane(task.work_status),
    missionId: null,
    reportPath: null,
    createdBy: 'crosscut-postgres',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function listCrossCutVisualCards(): SwarmKanbanCard[] {
  const taskList = runCrossCutVisualBoard('tasks') as CrossCutVisualTaskList
  return (Array.isArray(taskList.tasks) ? taskList.tasks : [])
    .map(crossCutTaskToCard)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title))
}

type ClaudeDetection = {
  available: boolean
  cliPath?: string | null
  dbPath: string
  workspacePath: string
  reason?: string
}

function env(name: string): string | null {
  const value = process.env[name]
  return value && value.trim() ? value.trim() : null
}

function firstEnv(names: string[]): string | null {
  for (const name of names) {
    const value = env(name)
    if (value) return value
  }
  return null
}

function configString(pathSegments: string[][]): string | null {
  const configPath = path.join(getClaudeRoot(), 'config.yaml')
  if (!fs.existsSync(configPath)) return null

  let parsed: unknown
  try {
    parsed = YAML.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Failed to read Kanban provider config from ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  for (const segments of pathSegments) {
    let value: unknown = parsed
    for (const segment of segments) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        value = undefined
        break
      }
      value = (value as Record<string, unknown>)[segment]
    }
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function normalizeKanbanProviderPreference(
  value: string | null,
): KanbanProviderPreference {
  const normalized = (value ?? 'sqlite').trim().toLowerCase()
  switch (normalized) {
    case 'sqlite':
    case 'claude':
    case 'hermes-sqlite':
      return 'sqlite'
    case 'local':
    case 'json':
      return 'local'
    case 'hermes-proxy':
    case 'proxy':
    case 'dashboard-proxy':
      return 'hermes-proxy'
    case 'crosscut-postgres':
    case 'crosscut':
      return 'crosscut-postgres'
    case 'auto':
      return 'auto'
    default:
      throw new Error(
        `Unsupported Kanban provider ${JSON.stringify(value)}. Supported providers: sqlite, local, hermes-proxy, crosscut-postgres, auto.`,
      )
  }
}

function normalizeKanbanApiVersion(
  value: string | null,
): KanbanStoreApiVersion {
  const normalized = (value ?? KANBAN_STORE_API_VERSION).trim()
  if (normalized === KANBAN_STORE_API_VERSION) return KANBAN_STORE_API_VERSION
  throw new Error(
    `Unsupported Kanban store API version ${JSON.stringify(
      value,
    )}. Supported API version: ${KANBAN_STORE_API_VERSION}.`,
  )
}

function resolveKanbanProviderSelection(): KanbanProviderSelection {
  const envProvider = firstEnv([
    'HERMES_KANBAN_STORE_PROVIDER',
    'KANBAN_STORE_PROVIDER',
    'CLAUDE_KANBAN_BACKEND',
  ])
  const envApiVersion = firstEnv([
    'HERMES_KANBAN_STORE_API_VERSION',
    'KANBAN_STORE_API_VERSION',
  ])

  const configProvider = envProvider
    ? null
    : configString([
        ['kanban', 'provider'],
        ['kanban', 'store_provider'],
        ['kanban_store', 'provider'],
      ])
  const configApiVersion = envApiVersion
    ? null
    : configString([
        ['kanban', 'api_version'],
        ['kanban', 'apiVersion'],
        ['kanban_store', 'api_version'],
        ['kanban_store', 'apiVersion'],
      ])

  return {
    provider: normalizeKanbanProviderPreference(envProvider ?? configProvider),
    apiVersion: normalizeKanbanApiVersion(envApiVersion ?? configApiVersion),
  }
}

function claudeProfileRoot(): string {
  return getWorkspaceClaudeHome()
}

function claudeDbPath(): string {
  return path.join(getClaudeRoot(), 'kanban.db')
}

function claudeWorkspacePath(): string {
  return path.join(getClaudeRoot(), 'kanban')
}

function claudeCliPath(): string | null {
  try {
    const output = execFileSync('which', ['claude'], {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim()
    return output || null
  } catch {
    return null
  }
}

function checkClaudeCli(): {
  ok: boolean
  path?: string | null
  reason?: string
} {
  const cli = claudeCliPath()
  if (!cli) return { ok: false, reason: 'claude CLI not found on PATH' }
  try {
    execFileSync(cli, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, CLAUDE_HOME: claudeProfileRoot() },
    })
    return { ok: true, path: cli }
  } catch (error) {
    return {
      ok: false,
      path: cli,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

function detectClaudeKanban(): ClaudeDetection {
  const dbPath = claudeDbPath()
  const workspacePath = claudeWorkspacePath()
  const hasDb = fs.existsSync(dbPath)
  const hasWorkspace = fs.existsSync(workspacePath)

  if (!hasDb && !hasWorkspace) {
    return {
      available: false,
      cliPath: null,
      dbPath,
      workspacePath,
      reason:
        'Hermes Kanban storage not found; using the local Swarm Board fallback.',
    }
  }

  const cli = checkClaudeCli()
  return {
    available: true,
    cliPath: cli.ok ? (cli.path ?? null) : null,
    dbPath,
    workspacePath,
    reason: cli.ok
      ? undefined
      : 'Hermes Kanban storage detected; CLI unavailable, using direct local storage access.',
  }
}

function createClaudeSqliteProvider(): SqliteKanbanStoreProvider {
  const detection = detectClaudeKanban()
  return new SqliteKanbanStoreProvider({
    providerId: 'claude',
    label: 'Hermes Kanban',
    detected: detection.available,
    writable: detection.available,
    dbPath: detection.dbPath,
    workspacePath: detection.workspacePath,
    cliPath: detection.cliPath ?? null,
    details: detection.available
      ? (detection.reason ??
        `Hermes Kanban storage detected (${detection.cliPath ?? 'direct sqlite'}, ${detection.dbPath})`)
      : (detection.reason ?? 'Hermes Kanban not detected.'),
    capabilities: HERMES_SQLITE_KANBAN_CAPABILITIES,
  })
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : Math.round(value * 1000)
  }
  if (typeof value === 'string' && value.trim()) {
    const asNum = Number(value)
    if (Number.isFinite(asNum)) return normalizeTimestamp(asNum)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

function mapClaudeStatus(
  status: string | null | undefined,
): SwarmKanbanCard['status'] {
  switch ((status ?? '').toLowerCase()) {
    case 'queued':
    case 'todo':
    case 'triage':
      return 'backlog'
    case 'ready':
      return 'ready'
    case 'running':
    case 'claimed':
    case 'in_progress':
      return 'running'
    case 'review':
      return 'review'
    case 'blocked':
      return 'blocked'
    case 'done':
    case 'complete':
    case 'completed':
      return 'done'
    default:
      return 'backlog'
  }
}

function mapBoardStatus(
  status: SwarmKanbanCard['status'] | null | undefined,
): string {
  switch (status) {
    case 'backlog':
      return 'queued'
    case 'ready':
      return 'ready'
    case 'running':
      return 'running'
    case 'review':
      return 'review'
    case 'blocked':
      return 'blocked'
    case 'done':
      return 'done'
    default:
      return 'queued'
  }
}

function claudeTaskToCard(task: KanbanTaskRecord): SwarmKanbanCard {
  const createdAt = normalizeTimestamp(task.createdAt)
  const updatedAt = normalizeTimestamp(
    task.updatedAt ?? task.completedAt ?? task.startedAt ?? task.createdAt,
  )
  return {
    id: task.id,
    title: task.title,
    spec: task.body ?? '',
    acceptanceCriteria: [],
    assignedWorker: task.assignee ?? null,
    reviewer: null,
    status: mapClaudeStatus(task.status),
    missionId: null,
    reportPath: null,
    createdBy: task.createdBy ?? 'claude-kanban',
    createdAt,
    updatedAt,
  }
}

const localBackend: KanbanBackend = {
  meta() {
    return withKanbanStoreContract({
      id: 'local',
      label: 'Local board',
      detected: true,
      writable: true,
      path: SWARM_KANBAN_FILE,
      details: 'Using local Swarm board JSON store.',
    })
  },
  list() {
    return listSwarmKanbanCards()
  },
  create(input) {
    return createSwarmKanbanCard(input)
  },
  update(cardId, updates) {
    return updateSwarmKanbanCard(cardId, updates)
  },
}

const claudeBackend: KanbanBackend = {
  meta() {
    const provider = createClaudeSqliteProvider()
    const metadata = provider.metadata()
    return {
      id: 'claude',
      label: metadata.label,
      detected: metadata.detected,
      writable: metadata.writable,
      path: metadata.path ?? null,
      details: metadata.details ?? null,
      apiVersion: metadata.apiVersion,
      capabilities: metadata.capabilities,
    }
  },
  list() {
    return createClaudeSqliteProvider().listTasks().map(claudeTaskToCard)
  },
  create(input) {
    const provider = createClaudeSqliteProvider()
    const metadata = provider.metadata()
    if (!metadata.detected)
      throw new Error(metadata.details ?? 'Hermes Kanban not detected')
    const created = provider.createTask({
      title: input.title,
      body: input.spec ?? '',
      assignee: input.assignedWorker ?? null,
      status: mapBoardStatus(
        input.status ?? 'backlog',
      ) as KanbanTaskRecord['status'],
      createdBy: input.createdBy?.trim() || 'swarm2-kanban',
      workspaceKind: 'scratch',
    })
    return claudeTaskToCard(created)
  },
  update(cardId, updates) {
    const provider = createClaudeSqliteProvider()
    const metadata = provider.metadata()
    if (!metadata.detected) return null
    const updated = provider.updateTask(cardId, {
      title: updates.title,
      body: updates.spec,
      assignee: updates.assignedWorker,
      status: updates.status
        ? (mapBoardStatus(updates.status) as KanbanTaskRecord['status'])
        : undefined,
    })
    return updated ? claudeTaskToCard(updated) : null
  },
}

const crossCutPostgresBackend: KanbanBackend = {
  meta() {
    const detection = detectCrossCutPostgres()
    return withKanbanStoreContract(
      {
        id: 'crosscut-postgres',
        label: 'CrossCut PostgreSQL visual board',
        detected: detection.available,
        writable: false,
        path: 'crosscut work visual-board',
        details: detection.available
          ? 'Read-only projection from CrossCut PostgreSQL work records; execution writes remain gated through CrossCut/Hermes paths.'
          : `CrossCut visual-board projection not detected${detection.reason ? `: ${detection.reason}` : '.'}`,
      },
      kanbanStoreCapabilities({
        boards: true,
        tasks: true,
        diagnostics: true,
      }),
    )
  },
  list() {
    return listCrossCutVisualCards()
  },
  create() {
    throw new Error('CrossCut PostgreSQL visual board provider is read-only')
  },
  update() {
    throw new Error('CrossCut PostgreSQL visual board provider is read-only')
  },
}

// Hermes Dashboard kanban plugin backend (HTTP proxy).
//
// Used when the upstream Hermes Agent dashboard exposes the kanban plugin
// (caps.kanban === true). Goes through HTTP rather than direct SQLite so
// remote workspaces (Docker, VPS, separate machines) can use the same
// kanban DB the agent is using. See kanban-dashboard-proxy.ts.
const dashboardProxyBackend: KanbanBackend = {
  meta() {
    const caps = getCapabilities()
    return withKanbanStoreContract(
      {
        id: 'hermes-proxy',
        label: 'Hermes Dashboard kanban',
        detected: caps.kanban,
        writable: caps.kanban,
        path: caps.dashboard.url || CLAUDE_DASHBOARD_URL,
        details: caps.kanban
          ? `Synced with the Hermes Dashboard kanban plugin at ${caps.dashboard.url}/kanban (single SQLite source of truth, dispatcher-aware).`
          : 'Hermes Dashboard kanban plugin not detected.',
      },
      HERMES_KANBAN_CAPABILITIES,
    )
  },
  async list() {
    const board = await fetchDashboardKanbanBoard()
    const cards: SwarmKanbanCard[] = []
    for (const column of board.columns) {
      for (const task of column.tasks) {
        cards.push(dashboardTaskToCard(task))
      }
    }
    return cards.sort(
      (a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title),
    )
  },
  async create(input) {
    const task = await createDashboardKanbanTask({
      title: input.title.trim(),
      body: (input.spec ?? '').trim() || undefined,
      assignee: input.assignedWorker?.trim() || undefined,
      status: mapLaneToDashboardStatus(input.status ?? 'backlog'),
      created_by: input.createdBy?.trim() || 'hermes-workspace',
    })
    return dashboardTaskToCard(task)
  },
  async update(cardId, updates) {
    const patch: Parameters<typeof updateDashboardKanbanTask>[1] = {}
    if (typeof updates.title === 'string' && updates.title.trim())
      patch.title = updates.title.trim()
    if (typeof updates.spec === 'string') patch.body = updates.spec
    if (updates.assignedWorker !== undefined)
      patch.assignee = updates.assignedWorker?.trim() || null
    if (updates.status) patch.status = mapLaneToDashboardStatus(updates.status)
    if (Object.keys(patch).length === 0) {
      // No-op patches: just refetch.
      const board = await fetchDashboardKanbanBoard()
      for (const column of board.columns) {
        for (const task of column.tasks) {
          if (task.id === cardId) return dashboardTaskToCard(task)
        }
      }
      return null
    }
    try {
      const updated = await updateDashboardKanbanTask(cardId, patch)
      return dashboardTaskToCard(updated)
    } catch (err) {
      if (err instanceof Error && err.message.includes('→ 404')) return null
      throw err
    }
  },
}

/**
 * Resolve which backend to use.
 *
 * Precedence (highest first):
 *   1. Env: HERMES_KANBAN_STORE_PROVIDER / KANBAN_STORE_PROVIDER / legacy
 *      CLAUDE_KANBAN_BACKEND (sqlite | local | hermes-proxy | crosscut-postgres | auto)
 *   2. Config: config.yaml kanban.provider or kanban_store.provider
 *   3. Default: sqlite (direct ~/.hermes/kanban.db when detected, local JSON
 *      fallback only when storage is absent)
 *
 * Env/config may also set HERMES_KANBAN_STORE_API_VERSION,
 * KANBAN_STORE_API_VERSION, kanban.api_version, or kanban_store.api_version.
 * Unsupported providers/API versions fail loudly instead of silently falling
 * back to a different durable store.
 */
export function resolveKanbanBackend(): KanbanBackend {
  const selection = resolveKanbanProviderSelection()
  if (selection.provider === 'local') return localBackend
  if (selection.provider === 'hermes-proxy') {
    return getCapabilities().kanban ? dashboardProxyBackend : localBackend
  }
  if (selection.provider === 'crosscut-postgres') {
    const crossCutMeta = crossCutPostgresBackend.meta()
    if (crossCutMeta.detected) return crossCutPostgresBackend
    if (getCapabilities().kanban) return dashboardProxyBackend
    const claudeMeta = claudeBackend.meta()
    return claudeMeta.detected ? claudeBackend : localBackend
  }
  if (selection.provider === 'sqlite') {
    const claudeMeta = claudeBackend.meta()
    return claudeMeta.detected ? claudeBackend : localBackend
  }

  // auto remains available for operators who want proxy-first behavior; the
  // safe default is direct SQLite so there is only one local durable store.
  if (getCapabilities().kanban) return dashboardProxyBackend
  const claudeMeta = claudeBackend.meta()
  if (claudeMeta.detected) return claudeBackend
  return localBackend
}

export function getKanbanBackendMeta(): KanbanBackendMeta {
  return resolveKanbanBackend().meta()
}

export async function listKanbanCards(): Promise<SwarmKanbanCard[]> {
  return Promise.resolve(resolveKanbanBackend().list())
}

export async function createKanbanCard(
  input: CreateSwarmKanbanCardInput,
): Promise<SwarmKanbanCard> {
  return Promise.resolve(resolveKanbanBackend().create(input))
}

export async function updateKanbanCard(
  cardId: string,
  updates: UpdateSwarmKanbanCardInput,
): Promise<SwarmKanbanCard | null> {
  return Promise.resolve(resolveKanbanBackend().update(cardId, updates))
}
