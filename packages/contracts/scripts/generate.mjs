import { mkdir, readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";

// The JSON file is authoritative. Both outputs are reproducible, ignored build inputs.
const schema = JSON.parse(await readFile(new URL("../schema/contracts.schema.json", import.meta.url), "utf8"));
const output = new URL("../src/generated/", import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(new URL("schema.ts", output), `// Generated from schema/contracts.schema.json.\nexport const schema = ${JSON.stringify(schema, null, 2)} as const;\n`);
await writeFile(new URL("types.ts", output), await compile(schema, "ContractDocument", {
  bannerComment: "/* Generated from schema/contracts.schema.json. Do not edit. */",
  additionalProperties: false,
  unknownAny: true,
}));
