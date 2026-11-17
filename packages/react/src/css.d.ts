// A part may import a stylesheet it cannot work without (the terminal's). The host's bundler
// is what loads it; this only tells TypeScript such an import is fine.
declare module '*.css'
