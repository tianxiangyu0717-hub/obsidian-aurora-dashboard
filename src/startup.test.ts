import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import { DEFAULT_DATA } from "./models";

vi.mock("obsidian", () => ({
  Plugin: class {},
  Notice: class {},
  TFile: class {},
  normalizePath: (path: string) => path
}));
vi.mock("./dashboard-view", () => ({
  AuroraDashboardView: class {},
  VIEW_TYPE_AURORA_DASHBOARD: "aurora-dashboard"
}));
vi.mock("./settings", () => ({ AuroraSettingTab: class {} }));
vi.mock("./stats-service", () => ({
  StatsService: class { invalidate() {} }
}));

import AuroraDashboardPlugin from "./main";

const preferencePath = ".obsidian/plugins/aurora-dashboard/startup-preference.json";

function setup(saved = structuredClone(DEFAULT_DATA), files = new Map<string, string>()) {
  const plugin = new AuroraDashboardPlugin({} as App, {} as PluginManifest);
  let layoutReady = () => {};
  let disk = structuredClone(saved);
  const save = vi.fn((value: typeof saved) => {
    disk = structuredClone(value);
    return Promise.resolve();
  });
  Object.assign(plugin, {
    app: {
      vault: {
        configDir: ".obsidian",
        adapter: {
          exists: (path: string) => Promise.resolve(files.has(path)),
          read: (path: string) => Promise.resolve(files.get(path)),
          write: (path: string, value: string) => {
            files.set(path, value);
            return Promise.resolve();
          },
          list: () => Promise.resolve({ files: [] })
        },
        on: vi.fn()
      },
      metadataCache: { on: vi.fn() },
      workspace: {
        onLayoutReady: (callback: () => void) => { layoutReady = callback; },
        getLeavesOfType: () => []
      }
    },
    manifest: { id: "aurora-dashboard" },
    loadData: () => Promise.resolve(structuredClone(disk)),
    saveData: save,
    registerView: vi.fn(),
    registerEvent: vi.fn(),
    addRibbonIcon: vi.fn(),
    addCommand: vi.fn(),
    addSettingTab: vi.fn()
  });
  const open = vi.spyOn(plugin, "openDashboard").mockResolvedValue();
  return { plugin, save, open, files, layout: () => layoutReady(), disk: () => disk };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function timers() {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
}

describe("startup preference persistence", () => {
  it("retains a disabled preference across statistics saves, stale synced data and reload", async () => {
    timers();
    const saved = structuredClone(DEFAULT_DATA);
    saved.settings.openOnStartup = true;
    const first = setup(saved);
    await first.plugin.onload();
    first.plugin.data.settings.openOnStartup = false;
    await first.plugin.saveSettings();
    first.plugin.requestDataSave();
    await vi.runAllTimersAsync();
    expect(first.disk().settings.openOnStartup).toBe(false);
    const reload = setup(saved, first.files);
    await reload.plugin.onload();
    reload.layout();
    await vi.runAllTimersAsync();
    expect(reload.plugin.data.settings.openOnStartup).toBe(false);
    expect(reload.open).not.toHaveBeenCalled();
    reload.plugin.data.settings.openOnStartup = true;
    await reload.plugin.saveSettings();
    const enabled = setup(first.disk(), first.files);
    await enabled.plugin.onload();
    enabled.layout();
    await vi.runAllTimersAsync();
    expect(enabled.open).toHaveBeenCalledOnce();
  });

  it("serializes a slow old save before the user's new preference", async () => {
    const context = setup();
    await context.plugin.onload();
    context.plugin.data.settings.openOnStartup = true;
    let finish = () => {};
    context.save.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const oldSave = context.plugin.saveDashboardPreferences();
    await Promise.resolve();
    context.plugin.data.settings.openOnStartup = false;
    const newSave = context.plugin.saveSettings();
    await Promise.resolve();
    expect(context.save).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([oldSave, newSave]);
    expect(context.disk().settings.openOnStartup).toBe(false);
  });

  it("checks the toggle again before opening and cancels startup on unload", async () => {
    timers();
    const saved = structuredClone(DEFAULT_DATA);
    saved.settings.openOnStartup = true;
    const context = setup(saved);
    await context.plugin.onload();
    context.layout();
    context.plugin.data.settings.openOnStartup = false;
    await vi.runAllTimersAsync();
    expect(context.open).not.toHaveBeenCalled();
    context.plugin.data.settings.openOnStartup = true;
    context.layout();
    context.plugin.onunload();
    await vi.runAllTimersAsync();
    expect(context.open).not.toHaveBeenCalled();
  });

  it("uses saved false, and defaults off if settings disappear", async () => {
    for (const files of [new Map<string, string>(), new Map([[preferencePath, "invalid json"]])]) {
      const context = setup(undefined, files);
      await context.plugin.onload();
      expect(context.plugin.data.settings.openOnStartup).toBe(false);
    }
  });

  it("recovers the save queue after a failed write", async () => {
    const context = setup();
    await context.plugin.onload();
    context.save.mockRejectedValueOnce(new Error("disk error"));
    await expect(context.plugin.saveSettings()).rejects.toThrow("disk error");
    context.plugin.data.settings.openOnStartup = true;
    await context.plugin.saveSettings();
    expect(context.disk().settings.openOnStartup).toBe(true);
  });
});
