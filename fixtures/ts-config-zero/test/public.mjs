import assert from "node:assert/strict"; import test from "node:test"; import { readLimit } from "../src/index.ts"; test("keeps zero",()=>assert.equal(readLimit(0),0));
