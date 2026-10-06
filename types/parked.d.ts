// What lens reads of the parked mod's state, where that mod is loaded: the
// place it last asked to be shown. Parked's own contract is the authority.

// `path` is absolute, or relative to the session's folder; `line` is 0 when
// only the file is meant; `n` counts the asks, so the same place asked for
// twice is two asks.
export type ParkedJumpSeen = { path: string; line: number; n: number }

declare module 'claude-code' {
  interface PluginState {
    parked: {
      jump: ParkedJumpSeen | null
    }
  }
}
