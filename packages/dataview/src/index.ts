// @omgbase/dataview — a Dataview Query Language (DQL) → OQX translator.
//
//   const { oqx, render, warnings } = translate('TABLE file.mtime FROM "notes" WHERE due < date(today)', { thisPath });
//   const hits = await query(oqx);   // the omgbase `query` tool
//   // render.columns[i].alias names the key of each hit to show under render.columns[i].name
//
// Semantics live in the engines (the OQX function registry: `date()`, `dur()`,
// the aggregates); this package is syntax only — pure TypeScript, no omgbase
// imports, `@omgbase/oqx` for the AST builders and the canonical printer.

export { translate } from "./translate.ts";
export type { Capabilities, Column, RenderShape, TaskShape, TranslateOptions, Translation } from "./translate.ts";
export { DqlError } from "./errors.ts";
export type { DqlErrorCode, DqlPosition } from "./errors.ts";
export { parseDql } from "./parser.ts";
export type * from "./ast.ts";
export { FUNCTIONS } from "./functions.ts";
export type { FunctionStatus } from "./functions.ts";
export { FILE_FIELDS, TASK_FIELDS, DATE_MEMBERS } from "./fields.ts";
export type { Derive, FileField, TaskField, Kind } from "./fields.ts";
export { NAMED_DATES, isDateLiteral, isDurationLiteral } from "./dates.ts";
