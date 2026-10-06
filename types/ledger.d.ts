// What lens reads of the ledger mod's run, where that mod is loaded: a copy of
// the few fields it uses, so lens needs no dependency and works alone. The
// ledger's own contract is the authority; keep these a subset of it.

export type LedgerFindingSeen = {
  id: number
  path: string
  line?: number
  severity: 'error' | 'warning' | 'note'
  summary: string
  task?: string
  at: number
  status: 'open' | 'fixed'
}

export type LedgerRunSeen = {
  findings: LedgerFindingSeen[]
}

declare module 'claude-code' {
  interface PluginState {
    ledger: {
      run: LedgerRunSeen | null
      // The place the ledger last asked to be shown (a finding's): a path from
      // the session's folder, a line (0 for the file), and a count of the asks.
      jump: { path: string; line: number; n: number } | null
    }
  }
}
