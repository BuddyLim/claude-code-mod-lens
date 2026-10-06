// Shared by the lens, parked and ledger mods. The source is the mod-kit folder;
// each mod carries a copy under hooks/kit, written there by sync.sh. Edit the
// source and sync, never a copy.

// The cells a pane leaves clear at each side.
export const PAD = 2

// Text no longer than `most`, an ellipsis standing for what was cut.
export const cut = (text: string, most: number): string =>
  text.length > most ? `${text.slice(0, Math.max(0, most - 1))}…` : text

// How long ago `then` was, as one short word: minutes, hours, then days.
export const ageOf = (then: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - then) / 60000))

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.round(minutes / 60)

  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}
