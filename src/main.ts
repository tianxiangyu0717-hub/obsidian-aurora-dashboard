import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import type { PluginManifest } from "obsidian";
import {
  normalizeTodoFilePath,
  recoverTodoFilePath,
  updateMarkdownTask
} from "./core";
import {
  AuroraDashboardView,
  VIEW_TYPE_AURORA_DASHBOARD
} from "./dashboard-view";
import {
  DEFAULT_DATA,
  DEFAULT_SETTINGS,
  type AuroraPluginData,
  type InstalledPlugin,
  type OpenTask,
  type StartupMode
} from "./models";
import { AuroraSettingTab } from "./settings";
import { StatsService } from "./stats-service";

export default class AuroraDashboardPlugin extends Plugin {
  data: AuroraPluginData = structuredClone(DEFAULT_DATA);
  stats!: StatsService;
  private saveTimer: number | null = null;
  private vaultEventsRegistered = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private startupTimer: number | null = null;
  private unloaded = false;

  async onload(): Promise<void> {
    await this.loadPluginData();
    this.stats = new StatsService(this.app, this);

    this.registerView(
      VIEW_TYPE_AURORA_DASHBOARD,
      (leaf) => new AuroraDashboardView(leaf, this)
    );

    this.addRibbonIcon("layout-dashboard", "打开 Dashboard", () => {
      void this.openDashboard("new-tab");
    });

    this.addCommand({
      id: "open-dashboard",
      name: "打开首页看板",
      callback: () => void this.openDashboard("new-tab")
    });

    this.addCommand({
      id: "refresh-dashboard",
      name: "重新扫描首页统计",
      callback: () => {
        this.stats.invalidate();
        this.refreshDashboardViews(true);
        new Notice("Dashboard 正在重新扫描");
      }
    });

    this.addSettingTab(new AuroraSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.registerVaultEvents();
      this.startupTimer = window.setTimeout(() => {
        this.startupTimer = null;
        if (!this.unloaded && this.data.settings.openOnStartup) {
          void this.openDashboard(this.data.settings.startupMode);
        }
      }, 0);
    });
  }

  onunload(): void {
    this.unloaded = true;
    if (this.startupTimer !== null) {
      window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.persistData();
    }
  }

  async openDashboard(
    mode: StartupMode = this.data.settings.startupMode
  ): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_AURORA_DASHBOARD
    )[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }

    const leaf =
      mode === "new-tab"
        ? this.app.workspace.getLeaf("tab")
        : this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_AURORA_DASHBOARD,
      active: true
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  requestDataSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.persistData();
    }, 500);
  }

  async saveSettings(): Promise<void> {
    this.stats.invalidate();
    await this.persistData(true);
    await this.saveTodoPathBackup();
    this.refreshDashboardViews(true);
  }

  async saveDashboardPreferences(): Promise<void> {
    await this.persistData();
    this.refreshDashboardViews();
  }

  // Every writer uses the same queue, so an older statistics save cannot
  // finish after a newer settings save and restore the old toggle value.
  private persistData(saveStartupPreference = false): Promise<void> {
    const snapshot = structuredClone(this.data);
    const write = this.saveQueue.then(async () => {
      if (saveStartupPreference) {
        await this.app.vault.adapter.write(
          this.startupPreferenceFile,
          `${JSON.stringify({
            version: 1,
            openOnStartup: snapshot.settings.openOnStartup,
            startupMode: snapshot.settings.startupMode
          }, null, 2)}\n`
        );
      }
      await this.saveData(snapshot);
    });
    this.saveQueue = write.catch(() => undefined);
    return write;
  }

  private get startupPreferenceFile(): string {
    return normalizePath(`${this.pluginDataDir}/startup-preference.json`);
  }

  private async loadStartupPreference(): Promise<void> {
    try {
      if (!(await this.app.vault.adapter.exists(this.startupPreferenceFile))) return;
      const value: unknown = JSON.parse(
        await this.app.vault.adapter.read(this.startupPreferenceFile)
      );
      if (!value || typeof value !== "object") return;
      const preference = value as Record<string, unknown>;
      if (preference.version !== 1) return;
      if (typeof preference.openOnStartup === "boolean") {
        this.data.settings.openOnStartup = preference.openOnStartup;
      }
      if (preference.startupMode === "replace-active" || preference.startupMode === "new-tab") {
        this.data.settings.startupMode = preference.startupMode;
      }
    } catch {
      // Keep the primary settings if the independent preference is unavailable.
    }
  }

  async getInstalledPlugins(): Promise<InstalledPlugin[]> {
    const pluginsDir = normalizePath(`${this.app.vault.configDir}/plugins`);
    if (!(await this.app.vault.adapter.exists(pluginsDir))) return [];

    const { folders } = await this.app.vault.adapter.list(pluginsDir);
    const plugins = await Promise.all(
      folders.map(async (folder): Promise<InstalledPlugin | null> => {
        try {
          const manifestPath = normalizePath(`${folder}/manifest.json`);
          const source = await this.app.vault.adapter.read(manifestPath);
          const parsed: unknown = JSON.parse(source);
          if (!isPluginManifest(parsed) || parsed.id === this.manifest.id) {
            return null;
          }
          return {
            id: parsed.id,
            name: parsed.name,
            description: parsed.description
          };
        } catch {
          return null;
        }
      })
    );

    return plugins
      .filter((plugin): plugin is InstalledPlugin => plugin !== null)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  async initializeQuickPlugins(plugins: InstalledPlugin[]): Promise<void> {
    if (this.data.settings.quickPluginsInitialized) return;
    this.data.settings.quickPluginIds = plugins.map((plugin) => plugin.id);
    this.data.settings.quickPluginsInitialized = true;
    await this.saveDashboardPreferences();
  }

  async updateTask(
    file: TFile,
    task: OpenTask,
    update: { completed?: boolean; text?: string }
  ): Promise<void> {
    await this.app.vault.process(file, (markdown) =>
      updateMarkdownTask(markdown, task, update)
    );
    this.stats.invalidate(file.path);
  }

  refreshDashboardViews(force = false): void {
    if (force) this.stats.invalidate();
    this.app.workspace
      .getLeavesOfType(VIEW_TYPE_AURORA_DASHBOARD)
      .forEach((leaf) => {
        if (leaf.view instanceof AuroraDashboardView) {
          leaf.view.requestRefresh();
        }
      });
  }

  private async loadPluginData(): Promise<void> {
    const saved = (await this.loadData()) as Partial<AuroraPluginData> | null;
    const backupPath = await this.loadTodoPathBackup();
    const conflictPaths =
      backupPath === null ? await this.loadConflictTodoPaths() : [];
    const todoFilePath = recoverTodoFilePath(
      saved?.settings?.todoFilePath,
      backupPath,
      conflictPaths
    );
    this.data = {
      ...structuredClone(DEFAULT_DATA),
      ...saved,
      settings: {
        ...DEFAULT_SETTINGS,
        ...(saved?.settings ?? {}),
        todoFilePath
      },
      activity: saved?.activity ?? {},
      linkSnapshots: saved?.linkSnapshots ?? {},
      fileWordCounts: saved?.fileWordCounts ?? {},
      trackingStartedAt: saved?.trackingStartedAt ?? null,
      linkTrackingStartedAt: saved?.linkTrackingStartedAt ?? null
    };
    await this.loadStartupPreference();
    await this.saveTodoPathBackup();
    if (todoFilePath && !saved?.settings?.todoFilePath) {
      await this.persistData();
    }
  }

  private get pluginDataDir(): string {
    return normalizePath(
      `${this.app.vault.configDir}/plugins/${this.manifest.id}`
    );
  }

  private get todoPathBackupFile(): string {
    return normalizePath(`${this.pluginDataDir}/todo-path-backup.json`);
  }

  private async saveTodoPathBackup(): Promise<void> {
    const payload = {
      version: 1,
      todoFilePath: normalizeTodoFilePath(this.data.settings.todoFilePath)
    };
    try {
      await this.app.vault.adapter.write(
        this.todoPathBackupFile,
        `${JSON.stringify(payload, null, 2)}\n`
      );
    } catch {
      // The primary Obsidian data file remains the source of truth.
    }
  }

  private async loadTodoPathBackup(): Promise<string | null> {
    try {
      if (!(await this.app.vault.adapter.exists(this.todoPathBackupFile))) {
        return null;
      }
      const parsed: unknown = JSON.parse(
        await this.app.vault.adapter.read(this.todoPathBackupFile)
      );
      return readTodoPath(parsed);
    } catch {
      return null;
    }
  }

  private async loadConflictTodoPaths(): Promise<unknown[]> {
    try {
      const { files } = await this.app.vault.adapter.list(this.pluginDataDir);
      const conflictFiles = files.filter((path) =>
        /\/data(?: \d+)?\.json$/u.test(path) && !path.endsWith("/data.json")
      );
      return await Promise.all(
        conflictFiles.map(async (path) => {
          try {
            const parsed: unknown = JSON.parse(
              await this.app.vault.adapter.read(path)
            );
            return readTodoPath(parsed);
          } catch {
            return "";
          }
        })
      );
    } catch {
      return [];
    }
  }

  private registerVaultEvents(): void {
    if (this.vaultEventsRegistered) return;
    this.vaultEventsRegistered = true;

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        void this.stats.recordFileChange(file).then(() => {
          this.refreshDashboardViews();
        });
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        void this.stats.recordFileChange(file, true).then(() => {
          this.refreshDashboardViews();
        });
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        this.stats.recordDelete(file);
        this.refreshDashboardViews();
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        this.stats.recordRename(file, oldPath);
        this.refreshDashboardViews();
      })
    );

    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.refreshDashboardViews();
      })
    );
  }
}

function readTodoPath(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.todoFilePath === "string") return record.todoFilePath;
  const settings = record.settings;
  if (!settings || typeof settings !== "object") return "";
  const todoFilePath = (settings as Record<string, unknown>).todoFilePath;
  return typeof todoFilePath === "string" ? todoFilePath : "";
}

function isPluginManifest(value: unknown): value is PluginManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.description === "string"
  );
}
