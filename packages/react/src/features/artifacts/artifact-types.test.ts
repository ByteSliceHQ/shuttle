import { describe, expect, test } from 'bun:test'

import {
  artifactTypeFor,
  defaultArtifactTypes,
  launchableArtifactTypes,
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
