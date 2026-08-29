import assert from "node:assert/strict"; import test from "node:test"; import { windowAverage } from "../src/index.ts"; test("uses trailing values",()=>assert.equal(windowAverage([1,3,5],2),4));
