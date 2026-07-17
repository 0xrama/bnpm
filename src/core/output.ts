export type ResultStatus = "success" | "failure" | "incomplete" | "cancelled";
export type ResultCategory = "success" | "usage" | "policy" | "integrity" | "network" | "incomplete" | "internal" | "cancelled";

export interface CommandResult {
  readonly status: ResultStatus;
  readonly category: ResultCategory;
  readonly exitCode: number;
  readonly summary: string;
  readonly humanMessage?: string;
  readonly evidence?: unknown;
}

export interface Output {
  info(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
  childOutput(stream: "stdout" | "stderr", text: string, attribution?: { readonly package?: string; readonly stage?: string; readonly truncated?: boolean }): void;
  result(result: CommandResult): void;
}

interface JsonEvent {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly type: "info" | "error" | "child-output" | "result";
  readonly command: string;
  readonly data: unknown;
}

const controlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u001B]/g;
const secretPatterns = [
  /(?:token|password|api[_-]?key|secret)\s*[:=]\s*[^\s]+/gi,
  /authorization\s*:\s*(?:bearer\s+)?[^\s]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
] as const;

export function sanitizeText(value: string): string {
  let sanitized = value;
  for (const pattern of secretPatterns) {
    sanitized = sanitized.replace(pattern, (match) => {
      const separator = match.indexOf("=") >= 0 ? "=" : ":";
      if (!match.includes(separator)) {
        return "[REDACTED]";
      }
      const key = match.slice(0, match.indexOf(separator) + 1);
      return `${key}[REDACTED]`;
    });
  }
  return sanitized
    .replace(controlCharacters, (character) => {
      if (character === "\n" || character === "\t" || character === "\r") {
        return character === "\r" ? "\\r" : character;
      }
      return "\\u" + character.codePointAt(0)?.toString(16).padStart(4, "0");
    })
    .replace(/\r/g, "\\r");
}

function sanitizeData(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeText(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeData);
  }
  if (typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      sanitized[sanitizeText(key)] = sanitizeData(nested);
    }
    return sanitized;
  }
  return String(value);
}

export function createOutput(json: boolean, command: string): Output {
  let sequence = 0;
  let finished = false;

  function emit(type: JsonEvent["type"], data: unknown): void {
    if (!json || finished) {
      return;
    }
    const event: JsonEvent = { schemaVersion: 1, sequence: ++sequence, type, command, data };
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }

  function human(message: string, stream: NodeJS.WriteStream): void {
    if (!finished) {
      stream.write(`${sanitizeText(message)}\n`);
    }
  }

  return {
    info(message, details) {
      if (json) {
        emit("info", { message: sanitizeText(message), ...(details === undefined ? {} : { data: sanitizeData(details) }) });
      } else {
        human(message, process.stdout);
      }
    },
    error(message, details) {
      if (json) {
        const mapped =
          typeof details === "object" &&
          details !== null &&
          "category" in details &&
          "exitCode" in details &&
          typeof details.category === "string" &&
          typeof details.exitCode === "number";
        emit(
          "error",
          {
            category: mapped ? details.category : "internal",
            exitCode: mapped ? details.exitCode : 70,
            message: sanitizeText(message),
            ...(details === undefined || !mapped ? { ...(details === undefined ? {} : { evidence: sanitizeData(details) }) } : {}),
          },
        );
      } else {
        human(message, process.stderr);
      }
    },
    childOutput(stream, text, attribution = {}) {
      if (json) {
        emit("child-output", sanitizeData({ stream, text, ...attribution }));
      } else {
        human(text, stream === "stdout" ? process.stdout : process.stderr);
      }
    },
    result(commandResult) {
      if (finished) {
        return;
      }
      const data = {
        status: commandResult.status,
        category: commandResult.category,
        exitCode: commandResult.exitCode,
        summary: sanitizeText(commandResult.summary),
        ...(commandResult.evidence === undefined ? {} : { evidence: sanitizeData(commandResult.evidence) }),
      };
      if (json) {
        emit("result", data);
      } else if (commandResult.status === "success") {
        human(commandResult.humanMessage ?? commandResult.summary, process.stdout);
      } else {
        human(commandResult.humanMessage ?? commandResult.summary, process.stderr);
      }
      finished = true;
    },
  };
}
