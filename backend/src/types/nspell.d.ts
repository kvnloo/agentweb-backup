/**
 * Minimal ambient types for `nspell` (ENG-2193). No `@types/nspell` package exists on the
 * registry, and the library itself ships no `.d.ts` (CJS, `main: lib/index.js`, no `types`
 * field) — this declares only the surface `creativeContentChecks.ts` actually calls.
 * See https://github.com/wooorm/nspell#api for the full API.
 */
declare module 'nspell' {
  export interface NspellDictionary {
    aff: Uint8Array;
    dic: Uint8Array;
  }

  export interface Nspell {
    /** Whether `word` is spelled correctly (or is a known exception/personal-dictionary entry). */
    correct(word: string): boolean;
    /** Suggested corrections for `word`, best first. */
    suggest(word: string): string[];
    /** Add `word` to the in-memory dictionary (used for the brand-terms allow-list). */
    add(word: string): Nspell;
  }

  export default function nspell(
    dictionary: NspellDictionary | NspellDictionary[],
  ): Nspell;
}
