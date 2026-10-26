// 从 contracts/*.schema.json 生成 TS 类型（同一权威 schema 的前端投影）。
// 支持 Pydantic 导出的子集：object/string/integer/boolean/array/enum/const/anyOf/$ref。
// 无法映射的类型显式降级为 unknown 并注释路径——不静默给错误类型。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const contractsDir = join(root, "contracts");
const outFile = join(root, "src", "contracts", "types.gen.ts");

const pascal = (s) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
  .replace(/^[a-z]/, (c) => c.toUpperCase());

function resolveRef(ref, rootSchema) {
  // ref_template "#/$defs/{model}"
  const name = ref.split("/").pop();
  return rootSchema.$defs?.[name];
}

function tsType(node, rootSchema, indent) {
  if (node === true) return "unknown";
  if (node === false) return "never";
  if (node.$ref) {
    const target = resolveRef(node.$ref, rootSchema);
    if (!target) return `unknown /* unresolved ${node.$ref} */`;
    return tsType(target, rootSchema, indent);
  }
  if (node.anyOf) return node.anyOf.map((n) => tsType(n, rootSchema, indent)).join(" | ");
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(" | ");
  if ("const" in node) return JSON.stringify(node.const);
  switch (node.type) {
    case "string": return "string";
    case "null": return "null";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "array": return `Array<${tsType(node.items ?? {}, rootSchema, indent)}>`;
    case "object": {
      const props = node.properties ?? {};
      const required = new Set(node.required ?? []);
      const lines = Object.entries(props).map(([key, sub]) => {
        const opt = required.has(key) ? "" : "?";
        const doc = sub.description ? `/** ${sub.description} */\n${indent}  ` : "";
        return `${indent}  ${doc}${JSON.stringify(key)}${opt}: ${tsType(sub, rootSchema, indent + "  ")};`;
      });
      const allowExtra = node.additionalProperties === true || node.additionalProperties === undefined;
      if (allowExtra && lines.length === 0) return "Record<string, unknown>";
      if (typeof node.additionalProperties === "object" && lines.length === 0) return `Record<string, ${tsType(node.additionalProperties, rootSchema, indent)}>`;
      const extra = allowExtra ? `${indent}  [key: string]: unknown;` : "";
      return `{\n${[...lines, extra].filter(Boolean).join("\n")}\n${indent}}`;
    }
    default: {
      // Pydantic Any 导出为无 type 的空约束节点 → unknown 是正确映射；
      // 其余无法识别的形状显式注释，不静默给错误类型。
      const known = ["$ref", "anyOf", "enum", "const", "type", "properties", "items"];
      if (known.every((k) => !(k in node))) return "unknown";
      return `unknown /* unsupported: ${JSON.stringify(node.type ?? node)} */`;
    }
  }
}

const files = readdirSync(contractsDir).filter((f) => f.endsWith(".schema.json")).sort();
const blocks = [
  "// 由 scripts/gen-ts-types.mjs 从 ../../contracts/*.schema.json 生成，勿手改。",
  "// 权威来源：ice_agent/contracts（Pydantic）。漂移由 tests/test_v2_contracts.py 阻断。",
  "",
];
for (const file of files) {
  const schema = JSON.parse(readFileSync(join(contractsDir, file), "utf8"));
  const name = "I" + pascal(schema.$id);
  blocks.push(`export type ${name} = ${tsType(schema, schema, "")};`);
  blocks.push("");
}
writeFileSync(outFile, blocks.join("\n"), "utf8");
console.log(`[gen-ts-types] ${files.length} type(s) -> ${outFile}`);
