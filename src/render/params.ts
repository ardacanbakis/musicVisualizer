/**
 * Resolving a mode's parameters from its schema plus whatever the user saved.
 *
 * Lives here rather than in the settings store so it stays a pure function of
 * (schema, saved) with no localStorage and no zustand in the way — this is the
 * logic that decides what a mode actually receives every frame, and it should
 * be testable without a browser.
 */
import { modeEntry } from './registry'
import { defaultParams } from './types'
import type { ParamSchema, ParamValues } from './types'

/**
 * Schema defaults with saved overrides applied on top.
 *
 * Two rules, both about surviving schema changes across releases:
 *  - A key the schema no longer declares is ignored, so a renamed param does
 *    not leave a dead value being handed to a shader forever.
 *  - A key the schema declares but the user never touched falls back to the
 *    default, so adding a param to a shipped mode does not break saved
 *    settings or require a migration.
 */
export function mergeParams(schema: ParamSchema, saved: ParamValues | undefined): ParamValues {
  const merged = defaultParams(schema)
  if (!saved) return merged
  for (const key of Object.keys(saved)) {
    if (!(key in schema)) continue
    const value = saved[key]
    // A value of the wrong type means the schema's type changed under a saved
    // setting. Falling back to the default beats handing a string to a
    // uniform that expects a float.
    if (typeof value === typeOf(schema[key])) merged[key] = value
  }
  return merged
}

function typeOf(def: ParamSchema[string]): 'number' | 'boolean' | 'string' {
  switch (def.type) {
    case 'float':
    case 'int':
      return 'number'
    case 'bool':
      return 'boolean'
    default:
      return 'string'
  }
}

/** Convenience wrapper keyed by mode id. */
export function resolveParams(
  modeId: string,
  saved: Record<string, ParamValues>,
): ParamValues {
  return mergeParams(modeEntry(modeId).params, saved[modeId])
}
