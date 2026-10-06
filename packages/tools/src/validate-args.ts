import type { JsonSchema } from "@kern/protocol";

/**
 * Minimal JSON-schema validation for tool arguments.
 * Covers the subset we actually emit in tool inputSchemas:
 * type: object with properties/required, scalar types, arrays.
 * Anything fancier passes through (providers own their dialect).
 */
export function validateArgs(schema: JsonSchema, args: unknown): string[] {
  const errors: string[] = [];
  checkValue(schema, args, "$", errors);
  return errors;
}

function checkValue(schema: { type?: string; properties?: Record<string, unknown>; required?: string[] }, value: unknown, path: string, errors: string[]): void {
  const type = schema.type;
  if (type === undefined) return;

  switch (type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${path}: expected object`);
        return;
      }
      const record = value as Record<string, unknown>;
      for (const req of schema.required ?? []) {
        if (!(req in record) || record[req] === undefined) {
          errors.push(`${path}.${req}: required field missing`);
        }
      }
      const props = (schema.properties ?? {}) as Record<string, { type?: string; properties?: Record<string, unknown>; required?: string[] }>;
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in record && record[key] !== undefined) {
          checkValue(propSchema, record[key], `${path}.${key}`, errors);
        }
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
      }
      break;
    }
    case "string": {
      if (typeof value !== "string") errors.push(`${path}: expected string`);
      break;
    }
    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) errors.push(`${path}: expected number`);
      break;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) errors.push(`${path}: expected integer`);
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
      break;
    }
    default:
      break;
  }
}
