import { describe, expect, it } from 'vitest'
import { mergeParams, resolveParams } from './params'
import { DEFAULT_MODE_ID, MODES, createMode, modeEntry } from './registry'
import { defaultParams } from './types'
import type { ParamSchema } from './types'

const SCHEMA = {
  size: { type: 'float', label: 'Size', default: 1.5, min: 0, max: 3 },
  count: { type: 'int', label: 'Count', default: 4, min: 1, max: 10 },
  mirror: { type: 'bool', label: 'Mirror', default: true },
  style: {
    type: 'enum',
    label: 'Style',
    default: 'soft',
    options: [
      { value: 'soft', label: 'Soft' },
      { value: 'hard', label: 'Hard' },
    ],
  },
  tint: { type: 'color', label: 'Tint', default: '#ff8800' },
} satisfies ParamSchema

describe('defaultParams', () => {
  it('pulls every default out of the schema', () => {
    expect(defaultParams(SCHEMA)).toEqual({
      size: 1.5,
      count: 4,
      mirror: true,
      style: 'soft',
      tint: '#ff8800',
    })
  })

  it('returns a fresh object each time, not a shared reference', () => {
    const a = defaultParams(SCHEMA)
    const b = defaultParams(SCHEMA)
    a.size = 99
    expect(b.size).toBe(1.5)
  })
})

describe('mergeParams', () => {
  it('returns defaults when nothing is saved', () => {
    expect(mergeParams(SCHEMA, undefined)).toEqual(defaultParams(SCHEMA))
  })

  it('applies saved overrides on top of defaults', () => {
    const merged = mergeParams(SCHEMA, { size: 2.75, mirror: false })
    expect(merged.size).toBe(2.75)
    expect(merged.mirror).toBe(false)
    // Untouched params still come from the schema.
    expect(merged.count).toBe(4)
    expect(merged.style).toBe('soft')
  })

  it('ignores saved keys the schema no longer declares', () => {
    // A renamed or removed param must not keep being handed to a shader.
    const merged = mergeParams(SCHEMA, { size: 2, removedLongAgo: 123 })
    expect(merged).not.toHaveProperty('removedLongAgo')
    expect(merged.size).toBe(2)
  })

  it('falls back to the default when a saved value has the wrong type', () => {
    // Happens when a param changes type between releases; handing a string to
    // a float uniform is worse than losing the customisation.
    const merged = mergeParams(SCHEMA, { size: 'wide', count: true, mirror: 'yes' })
    expect(merged.size).toBe(1.5)
    expect(merged.count).toBe(4)
    expect(merged.mirror).toBe(true)
  })

  it('accepts a new param added to a shipped mode without a migration', () => {
    const older = { size: 2 }
    const merged = mergeParams(SCHEMA, older)
    expect(merged.tint).toBe('#ff8800')
  })

  it('does not mutate the saved object', () => {
    const saved = { size: 2 }
    mergeParams(SCHEMA, saved)
    expect(saved).toEqual({ size: 2 })
  })
})

describe('registry', () => {
  it('has at least one mode and a valid default', () => {
    expect(MODES.length).toBeGreaterThan(0)
    expect(modeEntry(DEFAULT_MODE_ID).id).toBe(DEFAULT_MODE_ID)
  })

  it('has unique ids', () => {
    const ids = new Set(MODES.map((m) => m.id))
    expect(ids.size).toBe(MODES.length)
  })

  it('gives every mode a name, description and schema', () => {
    for (const mode of MODES) {
      expect(mode.name.length).toBeGreaterThan(0)
      expect(mode.description.length).toBeGreaterThan(0)
      expect(mode.params).toBeTruthy()
    }
  })

  it('every param default sits inside its own declared range', () => {
    for (const mode of MODES) {
      for (const [key, def] of Object.entries(mode.params)) {
        const where = `${mode.id}.${key}`
        if (def.type === 'float' || def.type === 'int') {
          expect(def.min, where).toBeLessThanOrEqual(def.default)
          expect(def.max, where).toBeGreaterThanOrEqual(def.default)
        }
        if (def.type === 'enum') {
          expect(def.options.map((o) => o.value), where).toContain(def.default)
        }
      }
    }
  })

  it('falls back to the first mode for an unknown id', () => {
    // A mode id persisted by an older build must not break startup.
    expect(modeEntry('deleted-in-a-past-release').id).toBe(MODES[0].id)
  })

  it('constructs modes without touching the GPU', () => {
    // The registry builds a probe of every mode at import time to read its
    // metadata. If a constructor allocated GL resources this would throw in a
    // plain node environment — which is exactly the contract being asserted.
    for (const mode of MODES) {
      const instance = createMode(mode.id)
      expect(instance.id).toBe(mode.id)
      // dispose() before init() must also be safe; the app can swap modes
      // before a frame has ever been rendered.
      expect(() => instance.dispose()).not.toThrow()
    }
  })
})

describe('resolveParams', () => {
  it('resolves a real mode against empty storage', () => {
    const params = resolveParams(DEFAULT_MODE_ID, {})
    expect(Object.keys(params).sort()).toEqual(
      Object.keys(modeEntry(DEFAULT_MODE_ID).params).sort(),
    )
  })

  it('only applies overrides belonging to the requested mode', () => {
    const [first, second] = MODES
    if (!second) return
    const firstKey = Object.keys(first.params)[0]
    const saved = { [second.id]: { [firstKey]: 999 } }
    expect(resolveParams(first.id, saved)).toEqual(defaultParams(first.params))
  })
})
