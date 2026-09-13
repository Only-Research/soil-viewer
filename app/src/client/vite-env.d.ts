/// <reference types="vite/client" />

/*
 * Vite's ambient types, which include the module declarations that make a side-effect CSS import
 * type-check. Without this, `import './tokens.css'` is a missing module rather than an asset the
 * bundler will inline.
 */
