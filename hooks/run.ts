// How a module that holds no engine handle runs a command. The hooks module,
// which holds the handle, passes each such module a `Run`; everything below
// it knows processes only through this.

export type Ran = { exitCode: number; stdout: string; stderr: string }

// Runs a command and never rejects: one that could not be started answers
// exit code -1 with the reason as its stderr, so a caller has one thing to
// check and nothing to catch.
export type Run = (
  argv: string[],
  init?: { cwd?: string; stdin?: string; timeoutMs?: number },
) => Promise<Ran>

// More files than this are not handed to one command.
export const FILE_LIMIT = 300

// The last words of what a command printed, short enough for a note or a toast.
export const tail = (text: string): string => text.trim().split('\n').slice(-2).join(' ').slice(0, 200)
