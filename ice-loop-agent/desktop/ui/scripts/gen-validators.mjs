// 构建期 Ajv 独立校验器代码生成（M0-06 决策 ADR：renderer 不开放 eval）。
// 读取 contracts/*.schema.json，为每个 $id 生成预编译校验模块到 src/contracts/generated/。
// 生成的代码不含 new Function/eval，可在 Electron CSP 下加载。
import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const contractsDir = join(root, "contracts");
const outDir = join(root, "src", "contracts", "generated");
mkdirSync(outDir, { recursive: true });

const files = readdirSync(contractsDir).filter((f) => f.endsWith(".schema.json"));
if (files.length === 0) throw new Error("contracts/ 下没有 *.schema.json");

const exports = [];
for (const file of files) {
  const schema = JSON.parse(readFileSync(join(contractsDir, file), "utf8"));
  if (!schema.$id) throw new Error(`${file} 缺少 $id`);
  const ajv = new Ajv2020({ code: { source: true, esm: true }, schemas: [schema] });
  const validateName = "validate_" + schema.$id.replace(/[^A-Za-z0-9]/g, "_");
  const validate = ajv.compile(schema);
  const code = standaloneCode(ajv, validate);
  const outName = basename(file).replace(".schema.json", ".validator.js");
  writeFileSync(join(outDir, outName), code, "utf8");
  writeFileSync(
    join(outDir, outName.replace(/\.js$/, ".d.ts")),
    "// 由 scripts/gen-validators.mjs 生成，勿手改。\n"
    + `declare const validate: (data: unknown) => boolean;\nexport default validate;\n`,
    "utf8",
  );
  exports.push(`export { default as ${validateName} } from "./generated/${outName}";`);
  console.log(`[gen-validators] ${schema.$id} -> ${outName}`);
}
writeFileSync(join(outDir, "..", "index.ts"), exports.join("\n") + "\n", "utf8");
console.log(`[gen-validators] ${files.length} validator(s) generated`);
