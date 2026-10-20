// The page query split (static/api.js) and the class colour fallback
// (static/classes.js, which mirrors lpc_view/classes.py).
import test from "node:test";
import assert from "node:assert/strict";
import { splitQuery } from "../../src/lpc_view/static/api.js";
import { classColor, hsvToRgb, setClassColor } from "../../src/lpc_view/static/classes.js";

test("splitQuery takes the token out and keeps the rest, ?debug among it", () => {
  assert.deepEqual(splitQuery("?token=abc"), { token: "abc", rest: "", debug: false });
  assert.deepEqual(splitQuery("?token=abc&debug"), { token: "abc", rest: "debug=", debug: true });
  assert.deepEqual(splitQuery("?files=1,2&token=abc&debug=1"), { token: "abc", rest: "files=1%2C2&debug=1", debug: true });
  assert.deepEqual(splitQuery("?debug"), { token: "", rest: "debug=", debug: true });
  assert.deepEqual(splitQuery(""), { token: "", rest: "", debug: false });
  assert.deepEqual(splitQuery("?token="), { token: "", rest: "", debug: false });
});

test("classColor hashes unnamed codes as classes.py does and keeps named ones", () => {
  // Values from lpc_view.classes.class_color for codes the table does not list.
  assert.deepEqual(classColor(25), [87, 178, 217]);
  assert.deepEqual(classColor(37), [217, 190, 87]);
  assert.deepEqual(classColor(64), [87, 217, 175]);
  assert.deepEqual(classColor(100), [193, 217, 87]);
  assert.deepEqual(classColor(255), [87, 217, 140]);
  setClassColor(2, [166, 118, 62]);
  assert.deepEqual(classColor(2), [166, 118, 62]);
  assert.deepEqual(hsvToRgb(0, 0, 1), [255, 255, 255]);
  assert.deepEqual(hsvToRgb(0, 1, 1), [255, 0, 0]);
  assert.deepEqual(hsvToRgb(1 / 3, 1, 1), [0, 255, 0]);
});
