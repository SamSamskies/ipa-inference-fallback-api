import { emitKeypressEvents } from "node:readline";

const promptError = (code) => Object.assign(new Error(code), { code });

/** Read from an interactive terminal without echoing or retaining input history. */
export async function promptProviderKey({ input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw promptError("prompt_requires_tty");
  }
  const wasRaw = input.isRaw === true;
  return new Promise((resolve, reject) => {
    const characters = [];
    let finished = false;
    function finish(error) {
      if (finished) return;
      finished = true;
      input.off("keypress", onKey);
      input.off("end", onEnd);
      input.off("error", onError);
      input.pause();
      input.setRawMode(wasRaw);
      output.write("\n");
      if (error) reject(promptError(error));
      else resolve(characters.join(""));
      characters.length = 0;
    }
    function onKey(text, key = {}) {
      if (key.ctrl && ["c", "d"].includes(key.name)) return finish("prompt_cancelled");
      if (["return", "enter"].includes(key.name)) return finish();
      if (key.name === "backspace") characters.pop();
      else if (key.ctrl && key.name === "u") characters.length = 0;
      else if (!key.ctrl && !key.meta && text && !text.startsWith("\x1b")) characters.push(text);
    }
    const onEnd = () => finish("prompt_closed");
    const onError = () => finish("prompt_failed");
    emitKeypressEvents(input);
    input.on("keypress", onKey);
    input.once("end", onEnd);
    input.once("error", onError);
    try {
      input.setRawMode(true);
      output.write("Provider API key (hidden): ");
      input.resume();
    } catch {
      finish("prompt_failed");
    }
  });
}
