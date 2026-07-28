/**
 * Guards on the shader sources.
 *
 * Shaders live inside JS template literals, which makes a backtick in a GLSL
 * comment a syntax error in the *TypeScript* file — and the resulting parse
 * error points at a line of GLSL with no obvious problem, which is a
 * genuinely confusing few minutes every time. It has bitten this codebase
 * three times. This turns it into a named failure.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDER_DIR = join(import.meta.dirname, '.')
const MODES_DIR = join(RENDER_DIR, 'modes')

function sourceFiles(): { path: string; source: string }[] {
  const files = [
    ...readdirSync(RENDER_DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => join(RENDER_DIR, f)),
    ...readdirSync(MODES_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(MODES_DIR, f)),
  ]
  return files.map((path) => ({ path, source: readFileSync(path, 'utf8') }))
}

/** Extract every /* glsl *\/ `...` block from a source file. */
function glslBlocks(source: string): string[] {
  const blocks: string[] = []
  const marker = '/* glsl */ `'
  let index = source.indexOf(marker)
  while (index !== -1) {
    const start = index + marker.length
    // Find the closing backtick, skipping over ${...} interpolations.
    let i = start
    let depth = 0
    while (i < source.length) {
      const char = source[i]
      if (char === '\\') {
        i += 2
        continue
      }
      if (char === '$' && source[i + 1] === '{') {
        depth++
        i += 2
        continue
      }
      if (char === '}' && depth > 0) {
        depth--
        i++
        continue
      }
      if (char === '`' && depth === 0) break
      i++
    }
    blocks.push(source.slice(start, i))
    index = source.indexOf(marker, i)
  }
  return blocks
}

describe('shader sources', () => {
  const files = sourceFiles()

  it('finds shader files to check', () => {
    expect(files.length).toBeGreaterThan(3)
    const withGlsl = files.filter((f) => f.source.includes('/* glsl */'))
    expect(withGlsl.length).toBeGreaterThan(3)
  })

  it('has no stray backticks truncating a GLSL block', () => {
    // A backtick inside a GLSL comment ends the template literal early, so it
    // never appears *inside* an extracted block — checking for one directly
    // is vacuous. What it leaves behind is a truncated block, and the
    // reliable signature of truncation is unbalanced braces.
    for (const { path, source } of files) {
      glslBlocks(source).forEach((block, index) => {
        let depth = 0
        for (const char of block) {
          if (char === '{') depth++
          else if (char === '}') depth--
        }
        expect(
          depth,
          `GLSL block ${index} in ${path} has unbalanced braces — usually a stray ` +
            'backtick in a comment ending the template literal early',
        ).toBe(0)
      })
    }
  })

  it('every GLSL block declares a main()', () => {
    // Also catches truncation, and catches a helper snippet accidentally
    // being used where a complete shader was meant.
    for (const { path, source } of files) {
      const blocks = glslBlocks(source)
      const shaders = blocks.filter((b) => b.includes('gl_Position') || b.includes('gl_FragColor'))
      for (const shader of shaders) {
        expect(shader, `incomplete shader in ${path}`).toContain('void main')
      }
    }
  })

  it('does not use GLSL ES 3.0 reserved words as identifiers', () => {
    // `sample` is reserved and fails to compile only at runtime, on a real GL
    // context — which means a plain build passes and the mode is a black
    // screen. Cheaper to catch here.
    const reserved = ['sample', 'filter', 'input', 'output', 'active', 'common', 'partition']
    for (const { path, source } of files) {
      for (const block of glslBlocks(source)) {
        for (const word of reserved) {
          const declaration = new RegExp(`\\b(?:float|int|vec[234]|mat[234]|bool)\\s+${word}\\b`)
          expect(declaration.test(block), `reserved word "${word}" declared in ${path}`).toBe(
            false,
          )
        }
      }
    }
  })

  it('prefixes shared colour helpers to avoid colliding with three', () => {
    // three injects its own luminance() into ShaderMaterial programs; an
    // unprefixed helper produces a redefinition error at shader-compile time.
    const glsl = readFileSync(join(RENDER_DIR, 'glsl.ts'), 'utf8')
    expect(glsl).toContain('ambLuminance')
    expect(glsl).not.toMatch(/\bfloat luminance\s*\(/)
  })
})
