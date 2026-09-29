export function safeStorageErrorDiagnostic(error: unknown): string {
  try {
    if (!(error instanceof Error)) return "UnknownError";
    if (error.name !== "SqliteError") return /^(?:Error|[A-Za-z][A-Za-z0-9]{0,63}Error)$/.test(error.name) ? error.name : "UnknownError";
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    return typeof code === "string" && /^SQLITE_[A-Z0-9_]{1,48}$/.test(code)
      ? `SqliteError:${code}` : "SqliteError";
  } catch {
    return "UnknownError";
  }
}
