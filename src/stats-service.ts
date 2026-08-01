import { TFile, TFolder, normalizePath } from "obsidian";
import type { App } from "obsidian";
import {
  buildCumulativeLinkHistory,
  countWords,
  dayKeysEndingToday,
  extractOpenTasks,
  localDateKey,
  normalizeTodoFilePath
} from "./core";
import type {
  ActivityEntry,
  AuroraDataStore,
  DailyActivity,
  DashboardSnapshot,
  DailyLinkCount,
  FolderSummary,
  KnowledgeGraphSnapshot,
  NoteMetric,
  OpenTask
} from "./models";

interface CachedMetric {
  mtime: number;
  size: number;
  words: number;
  tasks: OpenTask[];
}

export class StatsService {
  private readonly metricCache = new Map<string, CachedMetric>();
  private inFlightScan: Promise<DashboardSnapshot> | null = null;

  constructor(
    private readonly app: App,
    private readonly store: AuroraDataStore
  ) {}

  scan(force = false): Promise<DashboardSnapshot> {
    if (force) {
      this.metricCache.clear();
    }
    if (this.inFlightScan) {
      return this.inFlightScan;
    }
    this.inFlightScan = this.performScan().finally(() => {
      this.inFlightScan = null;
    });
    return this.inFlightScan;
  }

  invalidate(path?: string): void {
    if (path) {
      this.metricCache.delete(path);
    } else {
      this.metricCache.clear();
    }
  }

  async recordFileChange(file: TFile, isCreate = false): Promise<void> {
    if (!this.isIncluded(file)) return;

    const content = await this.app.vault.cachedRead(file);
    const newWordCount = countWords(content);
    const previousWordCount = this.store.data.fileWordCounts[file.path];
    const addedWords =
      previousWordCount === undefined
        ? isCreate
          ? newWordCount
          : 0
        : Math.max(0, newWordCount - previousWordCount);
    const today = localDateKey(new Date());
    const entry = this.store.data.activity[today] ?? {
      addedWords: 0,
      edits: 0,
      paths: []
    };

    entry.addedWords += addedWords;
    entry.edits += 1;
    if (!entry.paths.includes(file.path)) {
      entry.paths.push(file.path);
    }
    this.store.data.activity[today] = entry;
    this.store.data.fileWordCounts[file.path] = newWordCount;
    this.invalidate(file.path);
    this.store.requestDataSave();
  }

  recordDelete(file: TFile): void {
    delete this.store.data.fileWordCounts[file.path];
    this.invalidate(file.path);
    this.store.requestDataSave();
  }

  recordRename(file: TFile, oldPath: string): void {
    const previousCount = this.store.data.fileWordCounts[oldPath];
    if (previousCount !== undefined) {
      this.store.data.fileWordCounts[file.path] = previousCount;
      delete this.store.data.fileWordCounts[oldPath];
    }
    Object.values(this.store.data.activity).forEach((entry) => {
      const index = entry.paths.indexOf(oldPath);
      if (index >= 0) entry.paths[index] = file.path;
    });
    this.invalidate(oldPath);
    this.invalidate(file.path);
    this.store.requestDataSave();
  }

  private async performScan(): Promise<DashboardSnapshot> {
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => this.isIncluded(file));
    const cachedMetrics = await mapWithConcurrency(files, 10, (file) =>
      this.readMetric(file)
    );
    const backlinkCounts = this.buildBacklinkCounts(files);
    const notes: NoteMetric[] = files.map((file, index) => {
      const metric = cachedMetrics[index];
      if (!metric) {
        throw new Error(`Missing metric for ${file.path}`);
      }
      const cache = this.app.metadataCache.getFileCache(file);
      return {
        file,
        words: metric.words,
        backlinks: backlinkCounts.get(file.path) ?? 0,
        outgoingLinks: cache?.links?.length ?? 0,
        tasks: metric.tasks
      };
    });

    this.initializeTrackingBaseline(notes);

    const totalWords = notes.reduce((sum, note) => sum + note.words, 0);
    const unlinkedNotes = notes
      .filter((note) => note.backlinks === 0)
      .sort(compareByModifiedAscending);
    const shortNotes = notes
      .filter(
        (note) =>
          note.words <= this.store.data.settings.shortNoteWordThreshold
      )
      .sort((left, right) => left.words - right.words);
    const taskNotes = notes
      .filter((note) => note.tasks.length > 0)
      .sort((left, right) => right.tasks.length - left.tasks.length);
    const recentNotes = [...notes]
      .sort(compareByModifiedDescending)
      .slice(0, 6);
    const today = localDateKey(new Date());
    const modifiedToday = notes.filter(
      (note) => localDateKey(note.file.stat.mtime) === today
    ).length;
    const activity = this.buildActivity(notes);
    const graph = this.buildKnowledgeGraph(notes);
    this.recordLinkSnapshot(graph.edges.length);

    return {
      generatedAt: Date.now(),
      notes,
      noteCount: notes.length,
      totalWords,
      unlinkedNotes,
      shortNotes,
      taskNotes,
      recentNotes,
      modifiedToday,
      activity,
      trend: activity.slice(-30),
      linkHistory: this.buildLinkHistory(notes, graph),
      folders: this.buildFolderSummaries(notes),
      graph
    };
  }

  private isIncluded(file: TFile): boolean {
    const excluded = this.store.data.settings.excludedFolders
      .map((path) => normalizePath(path.trim()).replace(/\/$/u, ""))
      .filter(Boolean);
    return !excluded.some(
      (path) => file.path === path || file.path.startsWith(`${path}/`)
    );
  }

  private async readMetric(file: TFile): Promise<CachedMetric> {
    const cached = this.metricCache.get(file.path);
    if (
      cached &&
      cached.mtime === file.stat.mtime &&
      cached.size === file.stat.size
    ) {
      return cached;
    }

    const content = await this.app.vault.cachedRead(file);
    const metric: CachedMetric = {
      mtime: file.stat.mtime,
      size: file.stat.size,
      words: countWords(content),
      tasks: this.isTodoFile(file) ? extractOpenTasks(content) : []
    };
    this.metricCache.set(file.path, metric);
    return metric;
  }

  private isTodoFile(file: TFile): boolean {
    const configuredPath = normalizeTodoFilePath(
      this.store.data.settings.todoFilePath
    );
    if (!configuredPath) return false;
    return file.path === configuredPath;
  }

  private buildBacklinkCounts(files: TFile[]): Map<string, number> {
    const includedPaths = new Set(files.map((file) => file.path));
    const counts = new Map<string, number>();
    const resolvedLinks = this.app.metadataCache.resolvedLinks;

    Object.values(resolvedLinks).forEach((targets) => {
      Object.keys(targets).forEach((targetPath) => {
        if (includedPaths.has(targetPath)) {
          counts.set(targetPath, (counts.get(targetPath) ?? 0) + 1);
        }
      });
    });
    return counts;
  }

  private initializeTrackingBaseline(notes: NoteMetric[]): void {
    let changed = false;
    if (this.store.data.trackingStartedAt === null) {
      this.store.data.trackingStartedAt = Date.now();
      changed = true;
    }
    notes.forEach((note) => {
      if (this.store.data.fileWordCounts[note.file.path] === undefined) {
        this.store.data.fileWordCounts[note.file.path] = note.words;
        changed = true;
      }
    });
    if (changed) this.store.requestDataSave();
  }

  private buildActivity(notes: NoteMetric[]): DailyActivity[] {
    const historyDays = this.store.data.settings.activityHistoryDays;
    const keys = dayKeysEndingToday(historyDays);
    const trackingStart = this.store.data.trackingStartedAt
      ? localDateKey(this.store.data.trackingStartedAt)
      : localDateKey(new Date());
    const notesByMtime = new Map<string, NoteMetric[]>();
    notes.forEach((note) => {
      const key = localDateKey(note.file.stat.mtime);
      const list = notesByMtime.get(key) ?? [];
      list.push(note);
      notesByMtime.set(key, list);
    });

    return keys.map((date) => {
      const exact = this.store.data.activity[date];
      const isBeforeTracking = date < trackingStart;
      const estimatedNotes =
        this.store.data.settings.showEstimatedHistory && isBeforeTracking
          ? notesByMtime.get(date) ?? []
          : [];
      const exactFiles = (exact?.paths ?? [])
        .map((path) => this.app.vault.getAbstractFileByPath(path))
        .filter((file): file is TFile => file instanceof TFile);
      const files = uniqueFiles([
        ...estimatedNotes.map((note) => note.file),
        ...exactFiles
      ]);
      return {
        date,
        addedWords: isBeforeTracking
          ? estimatedNotes.reduce((sum, note) => sum + note.words, 0)
          : exact?.addedWords ?? 0,
        edits: isBeforeTracking
          ? estimatedNotes.length
          : exact?.edits ?? 0,
        estimated: isBeforeTracking && estimatedNotes.length > 0,
        files
      };
    });
  }

  private buildFolderSummaries(notes: NoteMetric[]): FolderSummary[] {
    const rootFolders = this.app.vault
      .getRoot()
      .children.filter((entry): entry is TFolder => entry instanceof TFolder);

    return rootFolders
      .map((folder) => {
        const folderNotes = notes.filter((note) =>
          note.file.path.startsWith(`${folder.path}/`)
        );
        return {
          path: folder.path,
          name: folder.name,
          noteCount: folderNotes.length,
          wordCount: folderNotes.reduce((sum, note) => sum + note.words, 0),
          files: folderNotes.map((note) => note.file)
        };
      })
      .filter((folder) => folder.noteCount > 0)
      .sort((left, right) => right.noteCount - left.noteCount);
  }

  private recordLinkSnapshot(count: number): void {
    const today = localDateKey(new Date());
    let changed = false;
    if (this.store.data.linkTrackingStartedAt === null) {
      this.store.data.linkTrackingStartedAt = Date.now();
      changed = true;
    }
    if (this.store.data.linkSnapshots[today] !== count) {
      this.store.data.linkSnapshots[today] = count;
      changed = true;
    }
    const oldestRetained = dayKeysEndingToday(400)[0];
    if (oldestRetained) {
      Object.keys(this.store.data.linkSnapshots).forEach((date) => {
        if (date < oldestRetained) {
          delete this.store.data.linkSnapshots[date];
          changed = true;
        }
      });
    }
    if (changed) this.store.requestDataSave();
  }

  private buildLinkHistory(
    notes: NoteMetric[],
    graph: KnowledgeGraphSnapshot
  ): DailyLinkCount[] {
    const notesByPath = new Map(
      notes.map((note) => [note.file.path, note] as const)
    );
    const estimatedLinkDates = graph.edges.map((edge) => {
      const source = notesByPath.get(edge.source);
      return localDateKey(source?.file.stat.mtime ?? Date.now());
    });
    return buildCumulativeLinkHistory(
      dayKeysEndingToday(365),
      estimatedLinkDates,
      this.store.data.linkSnapshots,
      this.store.data.linkTrackingStartedAt
    );
  }

  private buildKnowledgeGraph(notes: NoteMetric[]): KnowledgeGraphSnapshot {
    const includedPaths = new Set(notes.map((note) => note.file.path));
    const degree = new Map<string, number>();
    const edges = new Map<string, { source: string; target: string }>();

    Object.entries(this.app.metadataCache.resolvedLinks).forEach(
      ([source, targets]) => {
        if (!includedPaths.has(source)) return;
        Object.keys(targets).forEach((target) => {
          if (!includedPaths.has(target) || source === target) return;
          const key = `${source}\u0000${target}`;
          if (edges.has(key)) return;
          edges.set(key, { source, target });
          degree.set(source, (degree.get(source) ?? 0) + 1);
          degree.set(target, (degree.get(target) ?? 0) + 1);
        });
      }
    );

    return {
      nodes: notes.map((note) => ({
        file: note.file,
        degree: degree.get(note.file.path) ?? 0
      })),
      edges: [...edges.values()]
    };
  }

}

function compareByModifiedDescending(
  left: NoteMetric,
  right: NoteMetric
): number {
  return right.file.stat.mtime - left.file.stat.mtime;
}

function compareByModifiedAscending(
  left: NoteMetric,
  right: NoteMetric
): number {
  return left.file.stat.mtime - right.file.stat.mtime;
}

function uniqueFiles(files: TFile[]): TFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await mapper(item);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

export function mergeActivityEntry(
  current: ActivityEntry | undefined,
  update: Partial<ActivityEntry>
): ActivityEntry {
  return {
    addedWords: (current?.addedWords ?? 0) + (update.addedWords ?? 0),
    edits: (current?.edits ?? 0) + (update.edits ?? 0),
    paths: Array.from(
      new Set([...(current?.paths ?? []), ...(update.paths ?? [])])
    )
  };
}
