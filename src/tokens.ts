// Token model for Torque. String-literal unions keep the source
// "erasable-syntax" clean so Node runs it natively (no build step).

export type TT =
  | "num"      // numeric literal, possibly with fused unit suffix
  | "str"      // string literal
  | "ident"
  | "kw"
  | "op"
  | "topic"    // /path/to/topic
  | "anno"     // #[ inside annotation
  | "newline"
  | "eof"

export interface Token {
  tt: TT
  text: string        // raw text (for idents/kws/ops)
  value?: number      // parsed numeric value for num tokens
  unit?: string       // fused unit suffix, e.g. "mm", "deg", "%"
  str?: string        // decoded string value for str tokens
  path?: string       // topic path without leading slash
  line: number
  col: number
}

export const KEYWORDS = new Set([
  "fn", "let", "live", "loop", "topic", "on",
  "if", "else", "while", "for", "in",
  "return", "break", "continue",
  "true", "false", "nil",
])

export class TorqueSyntaxError extends Error {
  line: number
  col: number
  srcLine?: string
  constructor(msg: string, line: number, col: number, srcLine?: string) {
    super(msg)
    this.line = line
    this.col = col
    this.srcLine = srcLine
  }
}

export function formatError(e: TorqueSyntaxError, filename: string): string {
  const pad = String(e.line).padStart(4)
  const caret = " ".repeat(pad.length + 1 + (e.col - 1)) + "^"
  return `${filename}:${e.line}:${e.col}: ${e.message}\n    ${pad} | ${e.srcLine ?? ""}\n    ${caret}`
}
