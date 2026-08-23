// LLM tool-calling export.
//
// Functions annotated #[tool("description")] are exported as JSON tool
// definitions. The emitted objects carry BOTH `input_schema` (Anthropic
// Messages API spelling) and `inputSchema` (MCP spelling), so the same
// file can be pasted into either ecosystem.

import type { Program, FnDecl } from "./ast.ts"

export interface ToolParam {
  name: string
  typeName: string
}

export function collectTools(program: Program): FnDecl[] {
  const out: FnDecl[] = []
  for (const fn of program.fns.values()) {
    if (fn.toolDesc !== undefined) out.push(fn)
  }
  return out
}

export function paramSchema(typeName: string): { schema: Record<string, unknown>; description: string } {
  const unitTypes: Record<string, string> = {
    Length: "length in meters",
    Angle: "angle in radians",
    Duration: "duration in seconds",
    Mass: "mass in kilograms",
    Frequency: "frequency in hz",
    Velocity: "velocity in m/s",
    AngularVelocity: "angular velocity in rad/s",
    Force: "force in newtons",
    Torque: "torque in newton-meters",
  }
  if (unitTypes[typeName]) {
    return {
      schema: { type: "number" },
      description: `${typeName} — ${unitTypes[typeName]}`,
    }
  }
  switch (typeName) {
    case "int": case "i32":
      return { schema: { type: "integer" }, description: "integer" }
    case "number": case "f64": case "f32":
      return { schema: { type: "number" }, description: "number" }
    case "Bool": case "bool":
      return { schema: { type: "boolean" }, description: "boolean" }
    case "String": case "str":
      return { schema: { type: "string" }, description: "string" }
    case "Vec3":
      return {
        schema: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
        description: "3-vector [x, y, z]",
      }
    case "Pose":
      return {
        schema: {
          type: "object",
          properties: {
            pos: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
            rpy: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          },
          required: ["pos", "rpy"],
        },
        description: "pose {pos: [x,y,z] meters, rpy: [roll,pitch,yaw] radians}",
      }
    default:
      return { schema: {}, description: `value of type ${typeName}` }
  }
}

export function toolDefinitions(program: Program): Array<Record<string, unknown>> {
  const tools = collectTools(program)
  const defs = tools.map(fn => {
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const p of fn.params) {
      const { schema, description } = paramSchema(p.typeName)
      properties[p.name] = { ...schema, description }
      required.push(p.name)
    }
    const inputSchema = {
      type: "object",
      properties,
      required,
    }
    const ret = fn.retTypeName ? ` Returns ${fn.retTypeName}.` : ""
    return {
      name: fn.name,
      description: (fn.toolDesc || "") + ret,
      input_schema: inputSchema,   // Anthropic API spelling
      inputSchema,                 // MCP spelling
    }
  })
  return defs
}
