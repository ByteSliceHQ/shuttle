/** What `vite.config.ts` stamps into the build. */
interface ImportMetaEnv {
  readonly VITE_SHUTTLE_WORKER_PORT?: string
  readonly VITE_SHUTTLE_VERSION: string
  readonly VITE_SHUTTLE_COMMIT: string
  readonly VITE_SHUTTLE_BUILT_AT: string
}
