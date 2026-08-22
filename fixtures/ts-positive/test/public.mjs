import assert from "node:assert/strict"; import test from "node:test"; import { parsePositive } from "../src/index.ts"; test("rejects zero",()=>assert.throws(()=>parsePositive("0")));
