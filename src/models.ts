import type { TFile } from "obsidian";

export type StartupMode = "replace-active" | "new-tab";

export interface AuroraSettings {
  displayName: string;
  openOnStartup: boolean;
  startupMode: StartupMode;
  shortNoteWordThreshold: number;
  excludedFolders: string[];
  showEstimatedHistory: boolean;
  activityHistoryDays: number;
  todoFilePath: string;
  quickPluginIds: string[];
  quickPluginsInitialized: boolean;
}

export interface ActivityEntry {
  addedWords: number;
  edits: number;
  paths: string[];
}

export interface AuroraPluginData {
  settings: AuroraSettings;
  activity: Record<string, ActivityEntry>;
  linkSnapshots: Record<string, number>;
  fileWordCounts: Record<string, number>;
  trackingStartedAt: number | null;
  linkTrackingStartedAt: number | null;
}

export interface OpenTask {
  line: number;
  text: string;
  raw: string;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  description: string;
}

export interface KnowledgeGraphNode {
  file: TFile;
  degree: number;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
}

export interface KnowledgeGraphSnapshot {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

export interface NoteMetric {
  file: TFile;
  words: number;
  backlinks: number;
  outgoingLinks: number;
  tasks: OpenTask[];
}

export interface DailyActivity {
  date: string;
  addedWords: number;
  edits: number;
  estimated: boolean;
  files: TFile[];
}

export interface DailyLinkCount {
  date: string;
  count: number;
  estimated: boolean;
}

export interface FolderSummary {
  path: string;
  name: string;
  noteCount: number;
  wordCount: number;
  files: TFile[];
}

export interface DashboardSnapshot {
  generatedAt: number;
  notes: NoteMetric[];
  noteCount: number;
  totalWords: number;
  unlinkedNotes: NoteMetric[];
  shortNotes: NoteMetric[];
  taskNotes: NoteMetric[];
  recentNotes: NoteMetric[];
  modifiedToday: number;
  activity: DailyActivity[];
  trend: DailyActivity[];
  linkHistory: DailyLinkCount[];
  folders: FolderSummary[];
  graph: KnowledgeGraphSnapshot;
}

export interface AuroraDataStore {
  data: AuroraPluginData;
  requestDataSave(): void;
}

export const DEFAULT_SETTINGS: AuroraSettings = {
  displayName: "",
  openOnStartup: true,
  startupMode: "replace-active",
  shortNoteWordThreshold: 10,
  excludedFolders: [],
  showEstimatedHistory: true,
  activityHistoryDays: 365,
  todoFilePath: "",
  quickPluginIds: [],
  quickPluginsInitialized: false
};

export const DEFAULT_DATA: AuroraPluginData = {
  settings: DEFAULT_SETTINGS,
  activity: {},
  linkSnapshots: {},
  fileWordCounts: {},
  trackingStartedAt: null,
  linkTrackingStartedAt: null
};
