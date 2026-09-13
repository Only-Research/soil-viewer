import { describe, expect, it } from 'vitest'
import {
  foldCase,
  grammarKey,
  numericPrefixOf,
  stripNumericPrefix,
  toASCIILowerCase,
  toNFC,
} from '../../src/core/text'

describe('toNFC', () => {
  it('composes a decomposed sequence', () => {
    const decomposed = 'é' // e + combining acute
    const composed = 'é' // é
    expect(decomposed).not.toBe(composed)
    expect(toNFC(decomposed)).toBe(composed)
  })

  it('leaves an already-composed string alone', () => {
    expect(toNFC('é')).toBe('é')
  })

  it('is what makes two spellings of one filename compare equal', () => {
    // The real case: macOS has historically handed out NFD, agents write NFC.
    expect(toNFC('café.md')).toBe(toNFC('café.md'))
  })
})

describe('foldCase', () => {
  it('folds ASCII', () => {
    expect(foldCase('02-NEXT')).toBe('02-next')
    expect(foldCase('Archive')).toBe('archive')
  })

  it('leaves already-folded input unchanged (idempotent)', () => {
    const once = foldCase('Straße-ÅÄÖ')
    expect(foldCase(once)).toBe(once)
  })

  // Each of these is a documented divergence between toLowerCase() and simple case folding.
  // They are the reason foldCase exists rather than a bare toLowerCase call.
  describe('simple case folding differs from toLowerCase', () => {
    it('does not over-fold İ (U+0130)', () => {
      expect('İ'.toLowerCase()).toBe('i̇') // what the platform would have given us
      expect(foldCase('İ')).toBe('İ') // simple fold leaves it alone
    })

    it('folds final sigma to sigma', () => {
      expect('ς'.toLowerCase()).toBe('ς') // platform under-folds
      expect(foldCase('ς')).toBe('σ')
    })

    it('folds the micro sign to Greek mu', () => {
      expect(foldCase('µ')).toBe('μ')
    })

    it('folds long s to s', () => {
      expect(foldCase('ſ')).toBe('s')
    })

    it('folds capital sharp s to ß', () => {
      expect(foldCase('ẞ')).toBe('ß')
    })

    it('does NOT fold ß to ss — that is full folding, not simple', () => {
      // APFS treats straße and strasse as different files. Full folding would merge them
      // and make one shadow the other in the index.
      expect(foldCase('straße')).toBe('straße')
      expect(foldCase('straße')).not.toBe('strasse')
    })
  })

  it('folds the Greek symbol variants — added after the P1 review measured the claim false', () => {
    // The comment claimed Greek was covered while six of these were wrong. Pinned so the
    // claim and the code cannot drift apart again.
    expect(foldCase('\u03D0')).toBe('\u03B2') // beta symbol → beta
    expect(foldCase('\u03D1')).toBe('\u03B8') // theta symbol → theta
    expect(foldCase('\u03D5')).toBe('\u03C6') // phi symbol → phi
    expect(foldCase('\u03F0')).toBe('\u03BA') // kappa symbol → kappa
    expect(foldCase('\u03F1')).toBe('\u03C1') // rho symbol → rho
    expect(foldCase('\u03F5')).toBe('\u03B5') // lunate epsilon → epsilon
    expect(foldCase('\u1FBE')).toBe('\u03B9') // prosgegrammeni → iota
    expect(foldCase('\u0345')).toBe('\u03B9') // combining ypogegrammeni → iota
  })

  // Pinned so the known limit is visible in the suite rather than only in a comment.
  it('KNOWN LIMIT: does not correct Cherokee, which toLowerCase over-folds', () => {
    expect(foldCase('Ꭰ')).toBe('ꭰ')
    // If this ever needs to be correct, it requires the full CaseFolding.txt table — see
    // the note on FOLD_CORRECTIONS. Recorded, not silently accepted.
  })
})

describe('toASCIILowerCase', () => {
  it('lowercases ASCII', () => {
    expect(toASCIILowerCase('MD')).toBe('md')
  })

  it('leaves non-ASCII completely alone', () => {
    // Spec §6 wants the extension test narrow so nothing can lowercase its way into "md".
    expect(toASCIILowerCase('MDİ')).toBe('mdİ')
    expect(toASCIILowerCase('ΜΔ')).toBe('ΜΔ') // Greek capitals, not ASCII
  })

  it('is narrower than foldCase, deliberately', () => {
    expect(foldCase('ẞ')).toBe('ß')
    expect(toASCIILowerCase('ẞ')).toBe('ẞ')
  })
})

describe('stripNumericPrefix', () => {
  it('strips an NN- prefix', () => {
    expect(stripNumericPrefix('02-next')).toBe('next')
    expect(stripNumericPrefix('99-inbox-main')).toBe('inbox-main')
    expect(stripNumericPrefix('1-urgent')).toBe('urgent')
  })

  it('leaves a name with no prefix alone', () => {
    expect(stripNumericPrefix('archive')).toBe('archive')
    expect(stripNumericPrefix('tasks')).toBe('tasks')
  })

  it('strips only the first prefix', () => {
    expect(stripNumericPrefix('02-03-thing')).toBe('03-thing')
  })

  it('does not strip a bare number, a number with no hyphen, or a hyphen with no number', () => {
    expect(stripNumericPrefix('2026')).toBe('2026')
    expect(stripNumericPrefix('02next')).toBe('02next')
    expect(stripNumericPrefix('-next')).toBe('-next')
  })

  it('does not strip Unicode digits — they are not ordering prefixes', () => {
    // Arabic-Indic digits. Stripping these would let a crafted folder name impersonate a
    // grammar entry after normalization.
    expect(stripNumericPrefix('٠٢-next')).toBe('٠٢-next')
  })
})

describe('numericPrefixOf', () => {
  it('reads the prefix as a number', () => {
    expect(numericPrefixOf('02-next')).toBe(2)
    expect(numericPrefixOf('99-inbox-main')).toBe(99)
  })

  it('returns null when there is no prefix', () => {
    expect(numericPrefixOf('archive')).toBeNull()
  })

  it('orders lanes the way spec §3 requires', () => {
    const lanes = ['03-back-burner', '01-urgent', '04-done', '02-next']
    const sorted = [...lanes].sort((a, b) => (numericPrefixOf(a) ?? 0) - (numericPrefixOf(b) ?? 0))
    expect(sorted).toEqual(['01-urgent', '02-next', '03-back-burner', '04-done'])
  })
})

describe('grammarKey — the one matching rule of spec §3', () => {
  it('applies all three steps', () => {
    expect(grammarKey('02-Next')).toBe('next')
    expect(grammarKey('01-INBOX')).toBe('inbox')
    expect(grammarKey('Archive')).toBe('archive')
  })

  it('makes every spelling of one lane agree', () => {
    const spellings = ['02-next', '2-Next', 'NEXT', 'next', '99-next']
    const keys = new Set(spellings.map(grammarKey))
    expect(keys).toEqual(new Set(['next']))
  })

  it('normalizes before folding, not after', () => {
    // If the order were wrong, a decomposed name would fold to a different key than its
    // composed twin and the same folder would match the grammar under one spelling only.
    expect(grammarKey('ARCHIVÉ')).toBe(grammarKey('archive´'.replace('´', '́')))
  })

  it('is idempotent', () => {
    const once = grammarKey('02-Next')
    expect(grammarKey(once)).toBe(once)
  })

  it('does not let a lookalike become a grammar entry', () => {
    // Cyrillic а, not ASCII a. Must not match "archive".
    expect(grammarKey('аrchive')).not.toBe('archive')
  })
})
