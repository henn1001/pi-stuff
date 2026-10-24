import { describe, expect, test } from "bun:test";
import { setDisableModelInvocationInDocument, SkillDocumentError } from "./document.js";

const lf = `---\nname: demo\ndescription: Demo skill\n# keep this comment\n---\n\n# Body\nKeep me.\n`;

describe("setDisableModelInvocationInDocument", () => {
  test("inserts true without changing comments or body", () => {
    expect(setDisableModelInvocationInDocument(lf, true)).toBe(
      `---\nname: demo\ndescription: Demo skill\n# keep this comment\ndisable-model-invocation: true\n---\n\n# Body\nKeep me.\n`,
    );
  });

  test("writes explicit false when absent", () => {
    expect(setDisableModelInvocationInDocument(lf, false)).toContain(
      "disable-model-invocation: false\n---",
    );
  });

  test("replaces only the boolean and preserves inline comments", () => {
    const raw = lf.replace(
      "# keep this comment\n",
      "disable-model-invocation: true  # user note\n# keep this comment\n",
    );
    const expected = raw.replace(
      "disable-model-invocation: true",
      "disable-model-invocation: false",
    );
    expect(setDisableModelInvocationInDocument(raw, false)).toBe(expected);
  });

  test("preserves CRLF and missing final newline", () => {
    const raw = "---\r\nname: demo\r\ndescription: Demo\r\n---\r\nBody";
    const next = setDisableModelInvocationInDocument(raw, true);
    expect(next).toBe(
      "---\r\nname: demo\r\ndescription: Demo\r\ndisable-model-invocation: true\r\n---\r\nBody",
    );
    expect(next.endsWith("\n")).toBe(false);
  });

  test("replaces a CRLF boolean without normalizing newlines", () => {
    const raw =
      "---\r\nname: demo\r\ndescription: Demo\r\ndisable-model-invocation: true\r\n---\r\n";
    expect(setDisableModelInvocationInDocument(raw, false)).toBe(raw.replace(": true", ": false"));
  });

  test("is idempotent", () => {
    const raw = lf.replace(
      "# keep this comment\n",
      "disable-model-invocation: false\n# keep this comment\n",
    );
    expect(setDisableModelInvocationInDocument(raw, false)).toBe(raw);
  });

  test("rejects non-boolean and duplicate fields", () => {
    expect(() =>
      setDisableModelInvocationInDocument(
        lf.replace("# keep this comment", "disable-model-invocation: nope"),
        true,
      ),
    ).toThrow(SkillDocumentError);
    const duplicate = lf.replace(
      "# keep this comment",
      "disable-model-invocation: true\ndisable-model-invocation: false",
    );
    expect(() => setDisableModelInvocationInDocument(duplicate, true)).toThrow("duplicate");
  });

  test("rejects malformed delimiters", () => {
    expect(() => setDisableModelInvocationInDocument("name: demo\n", true)).toThrow("must start");
    expect(() => setDisableModelInvocationInDocument("---\nname: demo\n", true)).toThrow("closing");
  });
});