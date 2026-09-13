import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

/**
 * The SERVER build. Spec §2.5: the shipped product runs "the committed pre-built bundle plus the
 * zero-dependency Node server" — never the Vite dev server.
 *
 * A separate config because the two builds have nothing in common: the client targets a browser and
 * is content-hashed for caching; this targets Node, emits one file, and must not be hashed because
 * a launch agent has to name it.
 *
 * EVERY `node:` BUILTIN IS EXTERNAL, and nothing else is. That is the zero-dependency rule made
 * mechanical: if this bundle ever pulls in a package, the build fails to resolve it here rather
 * than succeeding and shipping it. `builtinModules` is used rather than a hand-written list so a
 * builtin added by a future Node cannot be accidentally inlined.
 */
export default defineConfig({
  build: {
    ssr: true,
    target: 'node24',
    outDir: 'dist-server',
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    rollupOptions: {
      input: 'src/server/main.ts',
      external: [...builtinModules, ...builtinModules.map(m => `node:${m}`)],
      output: { entryFileNames: 'main.js', format: 'esm' },
    },
  },
})
