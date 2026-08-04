import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("本地 accounts.txt 必须被 gitignore，避免真实凭据进入版本库", () => {
  const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  assert.match(gitignore, /(^|\r?\n)accounts\.txt(\r?\n|$)/);
});
