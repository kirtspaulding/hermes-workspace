import { describe, expect, it } from 'vitest'

import {
  KANBAN_STORE_API_VERSION,
  KANBAN_STORE_CAPABILITIES,
  kanbanStoreCapabilities,
  validateKanbanStoreProviderMetadata,
  type KanbanStoreProviderMetadata,
} from './kanban-store-contract'

describe('kanban-store-contract', () => {
  it('declares an explicit api version and complete boolean capability map', () => {
    const capabilities = kanbanStoreCapabilities({ tasks: true, claims: true })

    expect(KANBAN_STORE_API_VERSION).toBe('kanban-store.v1')
    expect(Object.keys(capabilities).sort()).toEqual(
      [...KANBAN_STORE_CAPABILITIES].sort(),
    )
    expect(capabilities.tasks).toBe(true)
    expect(capabilities.claims).toBe(true)
    expect(capabilities.comments).toBe(false)
  })

  it('validates provider metadata before a backend is treated as contract-compatible', () => {
    const metadata: KanbanStoreProviderMetadata = {
      providerId: 'fake-provider',
      label: 'Fake provider',
      apiVersion: KANBAN_STORE_API_VERSION,
      capabilities: kanbanStoreCapabilities({
        tasks: true,
        taskLinks: true,
        runs: true,
      }),
      detected: true,
      writable: true,
      storageAuthority: 'memory',
      details: 'test provider',
    }

    expect(validateKanbanStoreProviderMetadata(metadata)).toBe(metadata)
    expect(() =>
      validateKanbanStoreProviderMetadata({
        ...metadata,
        apiVersion: 'kanban-store.v0',
      } as KanbanStoreProviderMetadata),
    ).toThrow('Unsupported KanbanStore apiVersion')
    expect(() =>
      validateKanbanStoreProviderMetadata({
        ...metadata,
        capabilities: { tasks: true },
      } as KanbanStoreProviderMetadata),
    ).toThrow('capability boards must be declared')
  })
})
