import { randomUUID } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const KEY = "disable-model-invocation";

export class SkillDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillDocumentError";
  }
}

interface FrontmatterBounds {
  bodyStart: number;
  closeStart: number;
  newline: "\n" | "\r\n";
}

function findFrontmatterBounds(raw: string): FrontmatterBounds {
  const opening = raw.match(/^\uFEFF?---[ \t]*(\r?\n)/);
  if (!opening) {
    throw new SkillDocumentError("Skill must start with YAML frontmatter delimited by ---");
  }
  const bodyStart = opening[0].length;
  const closingPattern = /^---[ \t]*(?:\r?\n|$)/gm;
  closingPattern.lastIndex = bodyStart;
  const closing = closingPattern.exec(raw);
  if (!closing) {
    throw new SkillDocumentError("Skill frontmatter is missing its closing --- delimiter");
  }
  return {
    bodyStart,
    closeStart: closing.index,
    newline: opening[1] === "\r\n" ? "\r\n" : "\n",
  };
}

/** Return the original frontmatter block, including delimiters. */
export function extractFrontmatterText(raw: string): string {
  const bounds = findFrontmatterBounds(raw);
  const closing = /^---[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = bounds.closeStart;
  const match = closing.exec(raw);
  return raw.slice(0, match ? match.index + match[0].length : bounds.closeStart);
}

/**
 * Minimally set the top-level disable-model-invocation scalar.
 * Everything except the boolean token (or one inserted line) is preserved.
 */
export function setDisableModelInvocationInDocument(raw: string, disabled: boolean): string {
  const bounds = findFrontmatterBounds(raw);
  const frontmatter = raw.slice(bounds.bodyStart, bounds.closeStart);
  const keyPattern =
    /^(disable-model-invocation)([ \t]*:[ \t]*)(true|false)([ \t]*(?:#.*)?)(\r?)$/gm;
  const matches = [...frontmatter.matchAll(keyPattern)];

  // Detect unsupported/invalid forms separately so insertion cannot create duplicate YAML keys.
  const anyKeyPattern = /^disable-model-invocation[ \t]*:/gm;
  const anyMatches = [...frontmatter.matchAll(anyKeyPattern)];
  if (anyMatches.length > 1 || matches.length > 1) {
    throw new SkillDocumentError(`Skill frontmatter contains duplicate '${KEY}' fields`);
  }
  if (anyMatches.length === 1 && matches.length !== 1) {
    throw new SkillDocumentError(`'${KEY}' must be an unquoted top-level boolean true or false`);
  }

  if (matches.length === 1) {
    const match = matches[0]!;
    const current = match[3] === "true";
    if (current === disabled) {
      return raw;
    }
    const relativeValueStart = match.index! + match[1]!.length + match[2]!.length;
    const absoluteValueStart = bounds.bodyStart + relativeValueStart;
    return `${raw.slice(0, absoluteValueStart)}${disabled ? "true" : "false"}${raw.slice(absoluteValueStart + match[3]!.length)}`;
  }

  const parsedKeyLike = /^(?:["']disable-model-invocation["']|disable-model-invocation)[ \t]*:/gm;
  if (parsedKeyLike.test(frontmatter)) {
    throw new SkillDocumentError(
      `'${KEY}' uses an unsupported YAML spelling; use an unquoted top-level key`,
    );
  }
  return `${raw.slice(0, bounds.closeStart)}${KEY}: ${disabled ? "true" : "false"}${bounds.newline}${raw.slice(bounds.closeStart)}`;
}

export interface MutationResult {
  changed: boolean;
  disabled: boolean;
}

const fileQueues = new Map<string, Promise<void>>();

async function withFileMutationQueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveQueue) => {
    release = resolveQueue;
  });
  const chained = previous.then(() => current);
  fileQueues.set(path, chained);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (fileQueues.get(path) === chained) {
      fileQueues.delete(path);
    }
  }
}

function validate(raw: string): Record<string, unknown> {
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter<Record<string, unknown>>(raw).frontmatter;
  } catch (error) {
    throw new SkillDocumentError(
      `Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof frontmatter.name !== "string" || !frontmatter.name.trim()) {
    throw new SkillDocumentError("Skill frontmatter must contain a name");
  }
  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
    throw new SkillDocumentError("Skill frontmatter must contain a description");
  }
  const value = frontmatter[KEY];
  if (value !== undefined && typeof value !== "boolean") {
    throw new SkillDocumentError(`'${KEY}' must be a boolean true or false`);
  }
  return frontmatter;
}

function atomicWrite(path: string, content: string): void {
  const info = statSync(path);
  const temporary = join(dirname(path), `.${randomUUID()}.skill-toggle.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: info.mode });
    chmodSync(temporary, info.mode);
    renameSync(temporary, path);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {}
  }
}

export async function setSkillModelInvocation(
  path: string,
  enabled: boolean,
): Promise<MutationResult> {
  const queuePath = resolve(path);
  const target = realpathSync(queuePath);
  return withFileMutationQueue(target, async () => {
    const raw = readFileSync(target, "utf8");
    const before = validate(raw);
    if (Object.prototype.hasOwnProperty.call(before, KEY) && typeof before[KEY] !== "boolean") {
      throw new SkillDocumentError(`'${KEY}' must be a boolean true or false`);
    }
    const disabled = !enabled;
    const next = setDisableModelInvocationInDocument(raw, disabled);
    const after = validate(next);
    if (after[KEY] !== disabled) {
      throw new SkillDocumentError(
        "Updated frontmatter did not preserve the requested invocation state",
      );
    }
    if (next === raw) {
      return { changed: false, disabled };
    }
    atomicWrite(target, next);
    return { changed: true, disabled };
  });
}