export interface LogSink {
  appendLine(message: string): void;
}

let outputChannel: LogSink | undefined;

export function initLogger(channel: LogSink): void {
  outputChannel = channel;
}

export function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  outputChannel?.appendLine(line);
}

export function logError(message: string, error?: unknown): void {
  const errMsg =
    error instanceof Error ? error.message : String(error ?? "");
  log(`ERROR: ${message}${errMsg ? ` - ${errMsg}` : ""}`);
}
