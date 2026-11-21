import { describe, expect, test } from 'bun:test'

import {
  artifactTypeFor,
  defaultArtifactTypes,
  launchableArtifactTypes,
  servedArtifactTypes,
  type ArtifactType,
} from './artifact-types'

const designs: ArtifactType = {
  kind: 'acme:designs',
  label: 'Designs',
  icon: null,
  launcher: {},
  render: () => null,
}

describe('artifact types', () => {
  test("a host's own type sits beside Shuttle's and is offered where tabs are opened", () => {
    const types = [...defaultArtifactTypes, designs]

    expect(artifactTypeFor(types, 'acme:designs')).toBe(designs)
    expect(artifactTypeFor(defaultArtifactTypes, 'acme:designs')).toBeUndefined()

    expect(launchableArtifactTypes(types).map((type) => type.kind)).toEqual([
      'files',
      'terminal',
      'browser',
      'review',
      'media',
      'acme:designs',
    ])
  })

  test("the last type registered for a kind replaces the one before it, Shuttle's included", () => {
    const terminal: ArtifactType = {
      kind: 'terminal',
      label: 'Shell',
      icon: null,
      launcher: {},
      render: () => null,
    }

    const types = [...defaultArtifactTypes, terminal]

    expect(artifactTypeFor(types, 'terminal')).toBe(terminal)

    // Offered once, as the replacement.
    expect(launchableArtifactTypes(types).filter((type) => type.kind === 'terminal')).toEqual([
      terminal,
    ])
  })

  test('kinds saved by older sessions still open, and are not offered', () => {
    for (const kind of ['changes', 'file', 'events']) {
      expect(artifactTypeFor(defaultArtifactTypes, kind)).toBeDefined()
    }

    expect(
      launchableArtifactTypes(defaultArtifactTypes).some((type) => type.kind === 'changes'),
    ).toBe(false)
  })
})

const kinds = (types: readonly ArtifactType[]) => types.map((type) => type.kind)

describe('what the backend serves', () => {
  test('a backend that does not say what it serves is taken to serve everything', () => {
    expect(servedArtifactTypes(defaultArtifactTypes, null)).toBe(defaultArtifactTypes)
  })

  test('a type is left out when the backend lacks a module it needs', () => {
    const served = servedArtifactTypes(defaultArtifactTypes, {
      modules: ['session', 'runs'],
      previews: false,
      grants: false,
    })

    expect(kinds(served)).toEqual(['files', 'review', 'changes', 'file', 'events'])
  })

  test("a host's own type names the module of its own that it needs", () => {
    const boards: ArtifactType = { ...designs, kind: 'acme:boards', needs: ['acme-boards'] }
    const types = [...defaultArtifactTypes, designs, boards]
    const all = ['session', 'runs', 'assets', 'terminal']

    const without = servedArtifactTypes(types, { modules: all, previews: true, grants: false })

    const withIt = servedArtifactTypes(types, {
      modules: [...all, 'acme-boards'],
      previews: true,
      grants: false,
    })

    expect(kinds(without)).toContain('acme:designs')
    expect(kinds(without)).not.toContain('acme:boards')
    expect(kinds(withIt)).toContain('acme:boards')
  })
})
