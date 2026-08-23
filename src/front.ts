import { Lexer } from "./lexer.ts"
import { Parser } from "./parser.ts"
import type { Program } from "./ast.ts"

export function parseSource(src: string): Program {
  const toks = new Lexer(src).tokenize()
  return new Parser(toks, src).parseProgram()
}
