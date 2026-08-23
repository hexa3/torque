import type { Token } from "./tokens.ts"
import { TorqueSyntaxError } from "./tokens.ts"
import type {
  Expr, Stmt, Param, FnDecl, LoopDecl, TopicDecl, OnDecl, Program,
} from "./ast.ts"

// Recursive-descent parser. Newline-insensitive; statements are
// self-delimiting (blocks, keywords) with optional `;` separators.

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/="])

export class Parser {
  private p = 0
  private srcLines: string[] = []
  private toks: Token[]
  constructor(toks: Token[], src?: string) {
    this.toks = toks
    if (src !== undefined) this.srcLines = src.split("\n")
  }

  parseProgram(): Program {
    const prog: Program = { fns: new Map(), loops: [], topics: [], ons: [], stmts: [] }
    while (!this.atEof()) {
      if (this.peek().tt === "anno") {
        this.advance()
        const desc = this.parseAnnotationTail()
        const fn = this.parseFn()
        fn.toolDesc = desc
        this.declareFn(prog, fn)
        continue
      }
      if (this.checkKw("fn")) { this.declareFn(prog, this.parseFn()); continue }
      if (this.checkKw("loop")) { prog.loops.push(this.parseLoop()); continue }
      if (this.checkKw("topic")) { prog.topics.push(this.parseTopic()); continue }
      if (this.checkKw("on")) { prog.ons.push(this.parseOn()); continue }
      const s = this.parseStmt()
      if (s) prog.stmts.push(s)
    }
    return prog
  }

  private declareFn(prog: Program, fn: FnDecl) {
    if (prog.fns.has(fn.name)) this.err(`duplicate function '${fn.name}'`, fn)
    prog.fns.set(fn.name, fn)
  }

  // After consuming `#[`: expect tool("...") then ]
  private parseAnnotationTail(): string {
    const name = this.expectIdent("annotation name")
    if (!name) this.err("expected annotation name after '#['")
    this.expectOp("(")
    const t = this.peek()
    if (t.tt !== "str") this.err("expected string argument in annotation")
    this.advance()
    this.expectOp(")")
    this.expectOp("]")
    if (name !== "tool") this.err(`unknown annotation '#[${name}]' (only 'tool' is supported)`)
    return t.str ?? ""
  }

  parseFn(): FnDecl {
    const pos = this.here()
    this.expectKw("fn")
    const name = this.expectIdentWord()
    this.expectOp("(")
    const params: Param[] = []
    if (!this.checkOp(")")) {
      do {
        const pn = this.expectIdentWord()
        this.expectOp(":")
        const tn = this.expectTypeWord()
        params.push({ name: pn, typeName: tn, pos: this.here() })
      } while (this.matchOp(","))
    }
    this.expectOp(")")
    let retTypeName: string | undefined
    if (this.matchOp("->")) retTypeName = this.expectTypeWord()
    const body = this.parseBlock()
    return { kind: "fn", name, params, retTypeName, body, pos }
  }

  parseLoop(): LoopDecl {
    const pos = this.here()
    this.expectKw("loop")
    const name = this.expectIdentWord()
    this.expectOp("@")
    const freqExpr = this.parseExpr()
    let deadlineExpr: Expr | undefined
    if (this.matchOp(",")) {
      this.expectIdentIs("deadline")
      this.expectOp(":")
      deadlineExpr = this.parseExpr()
    }
    const body = this.parseBlock()
    return { kind: "loopdecl", name, freqExpr, deadlineExpr, body, pos }
  }

  parseTopic(): TopicDecl {
    const pos = this.here()
    this.expectKw("topic")
    const t = this.peek()
    if (t.tt !== "topic") this.err("expected topic path like /name")
    this.advance()
    this.expectOp(":")
    const typeName = this.expectTypeWord()
    let rateHz: number | undefined
    if (this.matchOp("@")) {
      const n = this.peek()
      if (n.tt !== "num" || n.unit !== "hz") this.err("expected rate like 50hz")
      this.advance()
      rateHz = n.value ?? 0
    }
    return { kind: "topicdecl", path: t.path!, typeName, rateHz, pos }
  }

  parseOn(): OnDecl {
    const pos = this.here()
    this.expectKw("on")
    const t = this.peek()
    if (t.tt !== "topic") this.err("expected topic path like /name")
    this.advance()
    this.expectOp("->")
    const varName = this.expectIdentWord()
    const body = this.parseBlock()
    return { kind: "ondecl", path: t.path!, varName, body, pos }
  }

  // ---- statements ----

  parseBlock(): Stmt[] {
    this.expectOp("{")
    const stmts: Stmt[] = []
    while (!this.checkOp("}") && !this.atEof()) {
      const s = this.parseStmt()
      if (s) stmts.push(s)
    }
    this.expectOp("}")
    return stmts
  }

  private terminated(): void {
    if (this.matchOp(";")) return
    // otherwise statement boundary is implicit (next token starts a new stmt)
  }

  parseStmt(): Stmt | null {
    const pos = this.here()
    if (this.matchOp(";")) return null
    if (this.checkKw("let") || this.checkKw("live")) {
      const isLive = this.checkKw("live")
      this.advance()
      const name = this.expectIdentWord()
      let typeName: string | undefined
      if (this.matchOp(":")) typeName = this.expectTypeWord()
      this.expectOp("=")
      const init = this.parseExpr()
      this.terminated()
      return { kind: "let", name, isLive, typeName, init, pos }
    }
    if (this.checkKw("if")) return this.parseIf()
    if (this.checkKw("while")) {
      this.advance()
      const cond = this.parseExpr()
      const body = this.parseBlock()
      return { kind: "while", cond, body, pos }
    }
    if (this.checkKw("for")) {
      this.advance()
      const varName = this.expectIdentWord()
      this.expectKw("in")
      const iter = this.parseExpr()
      const body = this.parseBlock()
      return { kind: "for", varName, iter, body, pos }
    }
    if (this.checkKw("return")) {
      this.advance()
      if (this.checkOp("}") || this.matchOp(";")) return { kind: "return", pos }
      const value = this.parseExpr()
      this.terminated()
      return { kind: "return", value, pos }
    }
    if (this.matchKw("break")) { this.terminated(); return { kind: "break", pos } }
    if (this.matchKw("continue")) { this.terminated(); return { kind: "continue", pos } }

    // Expression or assignment.
    const expr = this.parseExpr()
    if (this.checkOps(ASSIGN_OPS)) {
      const opTok = this.advance()
      const value = this.parseExpr()
      this.terminated()
      validateAssignTarget(expr, opTok)
      return { kind: "assign", target: expr, op: opTok.text as never, value, pos }
    }
    this.terminated()
    return { kind: "exprstmt", expr, pos }
  }

  parseIf(): Stmt {
    const pos = this.here()
    this.expectKw("if")
    const cond = this.parseExpr()
    const then = this.parseBlock()
    if (this.matchKw("else")) {
      if (this.checkKw("if")) {
        const nested = this.parseIf()
        return { kind: "if", cond, then, else: [nested], pos }
      }
      const els = this.parseBlock()
      return { kind: "if", cond, then, else: els, pos }
    }
    return { kind: "if", cond, then, pos }
  }

  // ---- expressions (precedence climbing) ----

  parseExpr(): Expr { return this.parseAssignment() }

  private parseAssignment(): Expr {
    // Only statement-level assignment is supported; inside expressions,
    // start at logical-or.
    return this.parseOr()
  }

  private parseOr(): Expr {
    let l = this.parseAnd()
    while (this.checkOp("||")) {
      const pos = this.here(); this.advance()
      l = { kind: "binary", op: "||", l, r: this.parseAnd(), pos }
    }
    return l
  }
  private parseAnd(): Expr {
    let l = this.parseEquality()
    while (this.checkOp("&&")) {
      const pos = this.here(); this.advance()
      l = { kind: "binary", op: "&&", l, r: this.parseEquality(), pos }
    }
    return l
  }
  private parseEquality(): Expr {
    let l = this.parseComparison()
    while (this.checkOp("==") || this.checkOp("!=")) {
      const op = this.advance()
      l = { kind: "binary", op: op.text, l, r: this.parseComparison(), pos: l }
    }
    return l
  }
  private parseComparison(): Expr {
    let l = this.parseAdditive()
    while (this.checkOps(new Set(["<", ">", "<=", ">="]))) {
      const op = this.advance()
      l = { kind: "binary", op: op.text, l, r: this.parseAdditive(), pos: l }
    }
    return l
  }
  private parseAdditive(): Expr {
    let l = this.parseMultiplicative()
    while (this.checkOp("+") || this.checkOp("-")) {
      const op = this.advance()
      l = { kind: "binary", op: op.text, l, r: this.parseMultiplicative(), pos: l }
    }
    return l
  }
  private parseMultiplicative(): Expr {
    let l = this.parseUnary()
    while (this.checkOps(new Set(["*", "/", "%"]))) {
      const op = this.advance()
      l = { kind: "binary", op: op.text, l, r: this.parseUnary(), pos: l }
    }
    return l
  }
  private parseUnary(): Expr {
    if (this.checkOp("-") || this.checkOp("!")) {
      const op = this.advance()
      return { kind: "unary", op: op.text as "-" | "!", expr: this.parseUnary(), pos: this.here() }
    }
    return this.parsePostfix()
  }
  private parsePostfix(): Expr {
    let e = this.parsePrimary()
    for (;;) {
      if (this.checkOp("(")) {
        const pos = this.here()
        this.advance()
        const args: Expr[] = []
        if (!this.checkOp(")")) {
          for (;;) {
            args.push(this.parseExpr())
            if (!this.matchOp(",")) break
            if (this.checkOp(")")) break // trailing comma
          }
        }
        this.expectOp(")")
        e = { kind: "call", callee: e, args, pos }
        continue
      }
      if (this.checkOp("[")) {
        const pos = this.here()
        this.advance()
        const idx = this.parseExpr()
        this.expectOp("]")
        e = { kind: "index", obj: e, index: idx, pos }
        continue
      }
      if (this.checkOp(".")) {
        this.advance()
        const name = this.expectIdentOrUnitWord()
        e = { kind: "member", obj: e, name, pos: e }
        continue
      }
      break
    }
    return e
  }
  private parsePrimary(): Expr {
    const t = this.peek()
    const pos = { line: t.line, col: t.col }
    if (t.tt === "op" && t.text === "%") {
      // bare % as a unit word, e.g. x.to(%) — evaluated only by .to()
      this.advance()
      return { kind: "member", obj: { kind: "num", value: 0, pos }, name: "%", pos }
    }
    if (t.tt === "num") {
      this.advance()
      return { kind: "num", value: t.value ?? 0, unit: t.unit, pos }
    }
    if (t.tt === "str") { this.advance(); return { kind: "str", value: t.str ?? "", pos } }
    if (t.tt === "topic") { this.advance(); return { kind: "topicref", path: t.path!, pos } }
    if (t.tt === "ident") { this.advance(); return { kind: "ident", name: t.text, pos } }
    if (t.tt === "kw") {
      if (t.text === "true" || t.text === "false") {
        this.advance()
        return { kind: "bool", value: t.text === "true", pos }
      }
      if (t.text === "nil") { this.advance(); return { kind: "nil", pos } }
    }
    if (t.tt === "op" && t.text === "(") {
      this.advance()
      const e = this.parseExpr()
      this.expectOp(")")
      return e
    }
    if (t.tt === "op" && t.text === "[") {
      this.advance()
      const items: Expr[] = []
      if (!this.checkOp("]")) {
        for (;;) {
          items.push(this.parseExpr())
          if (!this.matchOp(",")) break
          if (this.checkOp("]")) break // trailing comma
        }
      }
      this.expectOp("]")
      return { kind: "arraylit", items, pos }
    }
    if (t.tt === "op" && t.text === "{") {
      this.advance()
      const entries: [string, Expr][] = []
      if (!this.checkOp("}")) {
        for (;;) {
          const k = this.expectIdentOrUnitWord()
          this.expectOp(":")
          entries.push([k, this.parseExpr()])
          if (!this.matchOp(",")) break
          if (this.checkOp("}")) break // trailing comma
        }
      }
      this.expectOp("}")
      return { kind: "maplit", entries, pos }
    }
    this.err(`unexpected token '${t.text}'`)
  }

  // ---- token utilities ----
  private here() { const t = this.peek(); return { line: t.line, col: t.col } }
  private peek(o = 0): Token { return this.toks[Math.min(this.p + o, this.toks.length - 1)] }
  private advance(): Token { return this.toks[this.p++] }
  private atEof(): boolean { return this.peek().tt === "eof" }
  private checkKw(w: string): boolean { const t = this.peek(); return t.tt === "kw" && t.text === w }
  private matchKw(w: string): boolean { if (this.checkKw(w)) { this.p++; return true } return false }
  private checkOp(o: string): boolean { const t = this.peek(); return t.tt === "op" && t.text === o }
  private checkOps(ops: Set<string>): boolean { const t = this.peek(); return t.tt === "op" && ops.has(t.text) }
  private matchOp(o: string): boolean { if (this.checkOp(o)) { this.p++; return true } return false }
  private expectKw(w: string): Token {
    if (!this.checkKw(w)) this.err(`expected '${w}', got '${this.peek().text}'`)
    return this.advance()
  }
  private expectOp(o: string): Token {
    if (!this.checkOp(o)) this.err(`expected '${o}', got '${this.peek().text}'`)
    return this.advance()
  }
  private expectIdent(word: string): string | null {
    const t = this.peek()
    if (t.tt !== "ident" && !(t.tt === "kw")) this.err(`expected ${word}`)
    this.advance()
    return t.text
  }
  private expectIdentIs(word: string): void {
    const t = this.peek()
    if (!(t.tt === "ident" || t.tt === "kw") || t.text !== word) {
      this.err(`expected '${word}', got '${t.text}'`)
    }
    this.advance()
  }
  private expectIdentWord(): string {
    const t = this.peek()
    if (t.tt !== "ident") this.err(`expected identifier, got '${t.text}'`)
    this.advance()
    return t.text
  }
  private expectIdentOrUnitWord(): string {
    const t = this.peek()
    if (t.tt === "op" && t.text === "%") { this.advance(); return "%" }
    if (t.tt !== "ident" && t.tt !== "kw") this.err(`expected identifier, got '${t.text}'`)
    this.advance()
    return t.text
  }
  private expectTypeWord(): string {
    const t = this.peek()
    if (t.tt !== "ident") this.err(`expected type name, got '${t.text}'`)
    this.advance()
    return t.text
  }
  private err(msg: string, at?: { line: number; col: number }): never {
    const t = at ? { line: at.line, col: at.col } : this.peek()
    throw new TorqueSyntaxError(msg, t.line, t.col, this.srcLines[t.line - 1])
  }
}

function validateAssignTarget(expr: Expr, tok: Token) {
  if (expr.kind !== "ident" && expr.kind !== "index" && expr.kind !== "member") {
    throw new TorqueSyntaxError("invalid assignment target", tok.line, tok.col)
  }
}
