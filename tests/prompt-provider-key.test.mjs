import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promptProviderKey } from "../scripts/prompt-provider-key.mjs";

function terminal(wasRaw = false) {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = wasRaw;
  const rawModes = [];
  input.setRawMode = (enabled) => { input.isRaw = enabled; rawModes.push(enabled); };
  const output = new PassThrough();
  output.isTTY = true;
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  return { input, output, rawModes, text: () => text };
}

test("provider key input stays hidden, supports editing, and restores terminal mode", async () => {
  for (const wasRaw of [false, true]) {
    const tty = terminal(wasRaw);
    const answer = promptProviderKey(tty);
    tty.input.write("private-keyX");
    tty.input.write("\x7f");
    tty.input.write("\r");
    assert.equal(await answer, "private-key");
    assert.equal(tty.text(), "Provider API key (hidden): \n");
    assert.equal(tty.input.isRaw, wasRaw);
    assert.equal(tty.rawModes[0], true);
  }
});

test("cancellation and EOF restore the terminal and reveal no entered key", async () => {
  for (const action of ["interrupt", "end"]) {
    const tty = terminal();
    const answer = promptProviderKey(tty);
    tty.input.write("private-partial-key");
    if (action === "interrupt") tty.input.write("\x03");
    else tty.input.end();
    await assert.rejects(answer, { code: action === "interrupt" ? "prompt_cancelled" : "prompt_closed" });
    assert.equal(tty.text(), "Provider API key (hidden): \n");
    assert.equal(tty.input.isRaw, false);
  }
});

test("noninteractive input or output is rejected before reading a key", async () => {
  for (const stream of ["input", "output"]) {
    const tty = terminal();
    tty[stream].isTTY = false;
    await assert.rejects(promptProviderKey(tty), { code: "prompt_requires_tty" });
    assert.deepEqual(tty.rawModes, []);
    assert.equal(tty.text(), "");
  }
});
