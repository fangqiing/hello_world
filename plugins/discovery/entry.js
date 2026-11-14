// Thin loader boundary. Keeping each sibling under its own package root is
// what lets dsh-client-modules treat it as a distinct package on cold boot.
export * from '../discovery-runtime.js'
