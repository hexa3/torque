// AST node definitions for Torque.

export interface Pos { line: number; col: number }

export type Expr =
  | NumLit
  | StrLit
  | BoolLit
  | NilLit
  | Ident
  | TopicRef
  | Unary
  | Binary
  | Call
  | Index
  | Member
  | ArrayLit
  | MapLit

export interface NumLit { pos: Pos;
  kind: "num"
  value: number
  unit?: string          // fused unit suffix (mm, deg, ...) or undefined for plain
}
export interface StrLit  { pos: Pos; kind: "str"; value: string }
export interface BoolLit  { pos: Pos; kind: "bool"; value: boolean }
export interface NilLit  { pos: Pos; kind: "nil" }
export interface Ident  { pos: Pos; kind: "ident"; name: string }
export interface TopicRef  { pos: Pos; kind: "topicref"; path: string }

export interface Unary  { pos: Pos; kind: "unary"; op: "-" | "!"; expr: Expr }
export interface Binary  { pos: Pos; kind: "binary"; op: string; l: Expr; r: Expr }
export interface Call  { pos: Pos; kind: "call"; callee: Expr; args: Expr[] }
export interface Index  { pos: Pos; kind: "index"; obj: Expr; index: Expr }
export interface Member  { pos: Pos; kind: "member"; obj: Expr; name: string }
export interface ArrayLit  { pos: Pos; kind: "arraylit"; items: Expr[] }
export interface MapLit  { pos: Pos; kind: "maplit"; entries: [string, Expr][] }

export type Stmt =
  | LetStmt
  | Assign
  | IfStmt
  | WhileStmt
  | ForStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | ExprStmt

export interface LetStmt { pos: Pos;
  kind: "let"
  name: string
  isLive: boolean
  typeName?: string       // optional annotation `let x: Length = ...`
  init: Expr
}
export interface Assign { pos: Pos;
  kind: "assign"
  target: Expr            // Ident | Index | Member
  op: "=" | "+=" | "-=" | "*=" | "/="
  value: Expr
}
export interface IfStmt { pos: Pos;
  kind: "if"
  cond: Expr
  then: Stmt[]
  else?: Stmt[]           // may itself contain a single nested if
}
export interface WhileStmt  { pos: Pos; kind: "while"; cond: Expr; body: Stmt[] }
export interface ForStmt  { pos: Pos; kind: "for"; varName: string; iter: Expr; body: Stmt[] }
export interface ReturnStmt  { pos: Pos; kind: "return"; value?: Expr }
export interface BreakStmt  { pos: Pos; kind: "break" }
export interface ContinueStmt  { pos: Pos; kind: "continue" }
export interface ExprStmt  { pos: Pos; kind: "exprstmt"; expr: Expr }

export interface Param { name: string; typeName: string; pos: Pos }

export interface FnDecl { pos: Pos;
  kind: "fn"
  name: string
  params: Param[]
  retTypeName?: string
  body: Stmt[]
  toolDesc?: string       // from #[tool("...")]
}

export interface LoopDecl { pos: Pos;
  kind: "loopdecl"
  name: string
  freqExpr: Expr          // e.g. 50hz
  deadlineExpr?: Expr     // e.g. 2ms
  body: Stmt[]
}

export interface TopicDecl { pos: Pos;
  kind: "topicdecl"
  path: string            // without leading slash
  typeName: string
  rateHz?: number
}

export interface OnDecl { pos: Pos;
  kind: "ondecl"
  path: string
  varName: string
  body: Stmt[]
}

export interface Program {
  fns: Map<string, FnDecl>
  loops: LoopDecl[]
  topics: TopicDecl[]
  ons: OnDecl[]
  stmts: Stmt[]           // top-level let/live/expr statements
}
