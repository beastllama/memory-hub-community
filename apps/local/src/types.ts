export interface Source {
  id: string;
  path: string;
  hash: string;
  text: string;
}

export interface Note {
  id: string;
  text: string;
  sourceId: string;
  quote: string;
  kind: 'source' | 'ai';
}

export interface Scan {
  id: string;
  at: string;
  root: string;
  sources: Source[];
  notes: Note[];
  skipped: number;
  sensitive: number;
  partial: boolean;
}

export interface Project {
  id: string;
  name: string;
  root: string;
  scan: Scan;
  notes: Note[];
  selected: string[];
  savedPath: string | null;
  savedHash: string | null;
}

export interface HubState {
  version: 1;
  selectedId: string | null;
  destination: string;
  projects: Project[];
}

export interface AiConnection {
  id: string;
  kind: 'codex_cli';
  binaryPath: string;
  binaryHash: string;
  version: string;
  model: string;
  connectedAt: string;
}

export interface AiStatus {
  available: boolean;
  problem: string | null;
  detected: {
    binaryHash: string;
    binaryPath: string;
    version: string;
    suggestedModel: string | null;
    models: Array<{ id: string; label: string }>;
    loggedIn: boolean;
  } | null;
  connection: AiConnection | null;
}

export class HubError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
