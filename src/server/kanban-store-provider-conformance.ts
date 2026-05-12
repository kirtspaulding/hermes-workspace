import { describe, expect, it } from 'vitest'

import {
  KANBAN_STORE_API_VERSION,
  KANBAN_STORE_CAPABILITIES,
  validateKanbanStoreProviderMetadata,
  type KanbanStoreProvider,
  type KanbanTaskRecord,
  type MaybePromise,
} from './kanban-store-contract'

export type KanbanStoreProviderConformanceOptions = {
  name: string
  createProvider: () => MaybePromise<KanbanStoreProvider>
}

function expectTaskShape(task: KanbanTaskRecord): void {
  expect(task.id).toMatch(/^t_[A-Za-z0-9_-]+$/)
  expect(task.title.trim()).not.toBe('')
  expect(typeof task.status).toBe('string')
}

export function describeKanbanStoreProviderConformance(
  options: KanbanStoreProviderConformanceOptions,
): void {
  describe(`${options.name} KanbanStore provider conformance`, () => {
    it('returns valid v1 provider metadata with an explicit capability map', async () => {
      const provider = await options.createProvider()
      const metadata = validateKanbanStoreProviderMetadata(
        await provider.metadata(),
      )

      expect(metadata.apiVersion).toBe(KANBAN_STORE_API_VERSION)
      expect(metadata.providerId.trim()).not.toBe('')
      expect(metadata.label.trim()).not.toBe('')
      expect(typeof metadata.detected).toBe('boolean')
      expect(typeof metadata.writable).toBe('boolean')
      expect(Object.keys(metadata.capabilities).sort()).toEqual(
        [...KANBAN_STORE_CAPABILITIES].sort(),
      )
    })

    it('exposes a current board and can resolve that board by slug', async () => {
      const provider = await options.createProvider()
      const boards = await provider.listBoards()
      const current = boards.find((board) => board.current) ?? boards[0]

      expect(current).toBeTruthy()
      expect(current.slug.trim()).not.toBe('')
      expect(await provider.switchBoard(current.slug)).toMatchObject({
        slug: current.slug,
      })
    })

    it('supports the task create/read/list/update/archive lifecycle', async () => {
      const provider = await options.createProvider()
      const before = await provider.listTasks()
      expect(Array.isArray(before)).toBe(true)

      const created = await provider.createTask({
        title: 'Conformance task',
        body: 'Created by shared KanbanStore conformance tests',
        assignee: 'conformance-worker',
        status: 'todo',
        priority: 7,
        createdBy: 'kanban-store-conformance',
        workspaceKind: 'scratch',
      })

      expectTaskShape(created)
      expect(created).toMatchObject({
        title: 'Conformance task',
        body: 'Created by shared KanbanStore conformance tests',
        assignee: 'conformance-worker',
        status: 'todo',
      })

      expect(await provider.getTask(created.id)).toMatchObject({
        id: created.id,
        title: 'Conformance task',
      })
      expect(await provider.listTasks()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: created.id })]),
      )

      const updated = await provider.updateTask(created.id, {
        title: 'Updated conformance task',
        body: 'Updated body',
        assignee: null,
        status: 'done',
      })
      expect(updated).toMatchObject({
        id: created.id,
        title: 'Updated conformance task',
        body: 'Updated body',
        assignee: null,
        status: 'done',
      })

      expect(await provider.archiveTask(created.id)).toMatchObject({
        id: created.id,
        status: 'archived',
      })
    })

    it('reports stats and diagnostics as serializable objects', async () => {
      const provider = await options.createProvider()

      expect(await provider.stats()).toEqual(expect.any(Object))
      expect(await provider.diagnostics()).toEqual(expect.any(Object))
    })
  })
}
