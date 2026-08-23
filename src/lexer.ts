import type { Token, TT } from "./tokens.ts"
import { KEYWORDS, TorqueSyntaxError } from "./tokens.ts"

// Unit suffixes, longest-first so "mm" wins over "m", "Nm" over "N".
const UNIT_SUFFIXES = [
  "inch", "Nm", "mm", "cm", "km", "ft", "deg", "rad", "rev",
  "ms", "us", "min", "kg", "hz", "%", "m", "in", "s", "g", "N",
]
const UNIT_SET = new Set(UNIT_SUFFIXES)

const isDigit = (c: string) => c >= "0" && c <= "9"
const isIdentStart = (c: string) => /[A-Za-z_]/.test(c)
const isIdentChar = (c: string) => /[A-Za-z0-9_]/.test(c)

export class Lexer {
  private i = 0
  private line = 1
  private col = 1
  private out: Token[] = []
  private src: string
  constructor(src: string) { this.src = src }

  tokenize(): Token[] {
    this.out = []
    for (;;) {
      const t = this.next()
      if (t.tt === "eof") { this.out.push(t); break }
      if (t.tt !== "newline") this.out.push(t)
    }
    return this.out
  }

  private err(msg: string): never {
    throw new TorqueSyntaxError(msg, this.line, this.col, this.src.split("\n")[this.line - 1])
  }

  private peek(o = 0): string {
    return this.src[this.i + o] ?? ""
  }

  private advance(): string {
    const c = this.src[this.i++]
    if (c === "\n") { this.line++; this.col = 1 } else { this.col++ }
    return c
  }

  private make(tt: TT, text: string, line: number, col: number): Token {
    return { tt, text, line, col }
  }

  private next(): Token {
    this.skipTrivia()
    const line = this.line, col = this.col
    if (this.i >= this.src.length) return this.make("eof", "<eof>", line, col)
    const c = this.peek()
    if (isDigit(c) || (c === "." && isDigit(this.peek(1)))) {
      let text = ""
      while (isDigit(this.peek()) || this.peek() === "_") text += this.advance()
      if (this.peek() === "." && isDigit(this.peek(1))) {
        text += this.advance()
        while (isDigit(this.peek()) || this.peek() === "_") text += this.advance()
      }
      if (this.peek() === "e" || this.peek() === "E") {
        let j = 1
        if (this.peek(1) === "+" || this.peek(1) === "-") j = 2
        if (isDigit(this.peek(j))) {
          while (j-- > 0) text += this.advance()
          while (isDigit(this.peek())) text += this.advance()
        }
      }
      // Try to fuse a unit suffix only when it is immediately adjacent.
      let unit: string | undefined
      for (const u of UNIT_SUFFIXES) {
        if (u === "%" && this.peek() === "%") { unit = u; this.advance(); break }
        if (u !== "%" && this.src.startsWith(u, this.i)) {
          const after = this.peek(u.length)
          if (!isIdentChar(after)) { unit = u; for (let k = 0; k < u.length; k++) this.advance(); break }
        }
      }
      const tok = this.make("num", text, line, col)
      tok.value = parseFloat(text.replace(/_/g, ""))
      tok.unit = unit
      return tok
    }

    // String literal.
    if (c === '"') {
      this.advance()
      let s = ""
      for (;;) {
        if (this.i >= this.src.length) this.err("unterminated string")
        const ch = this.advance()
        if (ch === '"') break
        if (ch === "\\") {
          const esc = this.advance()
          s += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === '"' ? '"' : esc === "\\" ? "\\" : esc
        } else s += ch
      }
      const tok = this.make("str", `"..."`, line, col)
      tok.str = s
      return tok
    }

    // Identifier / keyword.
    if (isIdentStart(c)) {
      let id = ""
      while (isIdentChar(this.peek())) id += this.advance()
      return this.make(KEYWORDS.has(id) ? "kw" : "ident", id, line, col)
    }

    // Topic path: slash followed directly by an identifier character,
    // unless the previous token could end an operand (then it's division).
    if (c === "/" && /[A-Za-z_]/.test(this.peek(1)) && !endsOperand(this.out)) {
      let path = ""
      this.advance()
      while (/[A-Za-z0-9_\-]/.test(this.peek())) path += this.advance()
      while (this.peek() === "/" && /[A-Za-z_]/.test(this.peek(1))) {
        this.advance()
        path += "/"
        while (/[A-Za-z0-9_\-]/.test(this.peek())) path += this.advance()
      }
      const tok = this.make("topic", "/" + path, line, col)
      tok.path = path
      return tok
    }

    // Annotation opener `#[`
    if (c === "#" && this.peek(1) === "[") {
      this.advance(); this.advance()
      return this.make("anno", "#[", line, col)
    }

    // Operators (longest first).
    for (const op of ["->", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "&&", "||"]) {
      if (this.src.startsWith(op, this.i)) {
        for (let k = 0; k < op.length; k++) this.advance()
        return this.make("op", op, line, col)
      }
    }
    if ("+-*/%<>=!(){}[],:.@;".includes(c)) {
      return this.make("op", this.advance(), line, col)
    }

    this.err(`unexpected character '${c}'`)
  }

  private skipTrivia() {
    for (;;) {
      const c = this.peek()
      if (c === " " || c === "\t" || c === "\r" || c === "\n") { this.advance(); continue }
      if (c === "/" && this.peek(1) === "/") {
        while (this.peek() && this.peek() !== "\n") this.advance()
        continue
      }
      if (c === "/" && this.peek(1) === "*") {
        this.advance(); this.advance()
        for (;;) {
          if (this.i >= this.src.length) this.err("unterminated block comment")
          if (this.peek() === "*" && this.peek(1) === "/") { this.advance(); this.advance(); break }
          this.advance()
        }
        continue
      }
      break
    }
  }
}

// True when the previous token could end an operand — then a `/` is
// division, not the start of a topic path.
function endsOperand(out: Token[]): boolean {
  const last = out[out.length - 1]
  if (!last) return false
  return (
    last.tt === "num" || last.tt === "str" ||
    (last.tt === "ident" && !KEYWORDS.has(last.text)) ||
    (last.tt === "op" && (last.text === ")" || last.text === "]"))
  )
}
