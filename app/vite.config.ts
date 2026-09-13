import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * THE BUILD STAMP. Spec §15:
 *
 *   "The built shell carries a build stamp (a meta tag with the build timestamp or hash) so that
 *   freshness is machine-checkable: fetch the shell, read the stamp, know exactly which build the
 *   phone is running. Without it, 'is the fix deployed?' is unanswerable without the phone in hand."
 *
 * That is the whole reason, and it is an iOS problem specifically: an installed web app is RESUMED,
 * never relaunched, so a deployed fix can sit undelivered indefinitely with nothing to check from
 * the Mac. The placeholder is replaced at build time; a shell that still carries the literal
 * `__BUILD_STAMP__` means the transform did not run, which is itself worth noticing — so the
 * asset-map loader asserts the placeholder is gone rather than assuming.
 */
const buildStamp = (): string => new Date().toISOString()

const stampShell = () => ({
  name: 'soil-build-stamp',
  // The object form with an explicit order. The bare-function shorthand silently did nothing here
  // and the shell shipped carrying the literal placeholder — caught because the build output was
  // grepped rather than assumed. `post` so the replacement lands after asset URLs are rewritten.
  transformIndexHtml: {
    order: 'post' as const,
    // replaceAll, not replace. The source carried the placeholder twice — once in an HTML
      // comment explaining it and once in the meta tag — so `replace` stamped the comment and left
      // the tag saying `__BUILD_STAMP__` forever. Caught by grepping the built output instead of
      // trusting that the plugin ran. The comment no longer repeats it; replaceAll makes that
      // irrelevant rather than load-bearing.
      handler: (html: string) => html.replaceAll('__BUILD_STAMP__', buildStamp()),
  },
})

export default defineConfig({
  plugins: [react(), stampShell()],
  root: 'src/client',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    port: 5273,
  },
  preview: {
    host: '127.0.0.1',
    strictPort: true,
  },
})
