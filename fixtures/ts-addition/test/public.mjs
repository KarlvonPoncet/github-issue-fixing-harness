import assert from "node:assert/strict";
import test from "node:test";
import { add } from "../src/index.ts";
test("adds", () => assert.equal(add(4, 2), 6));
