import {
  Modal,
  PluginSettingTab,
  Setting,
  normalizePath
} from "obsidian";
import type { App, SettingDefinitionItem } from "obsidian";
import type AuroraDashboardPlugin from "./main";
import type { StartupMode } from "./models";
import { normalizeTodoFilePath } from "./core";

type AuroraSettingKey =
  | "displayName"
  | "openOnStartup"
  | "startupMode"
  | "todoFilePath"
  | "shortNoteWordThreshold"
  | "excludedFolders"
  | "showEstimatedHistory"
  | "activityHistoryDays";

export class AuroraSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly auroraPlugin: AuroraDashboardPlugin
  ) {
    super(app, auroraPlugin);
  }

  display(): void {
    renderSettings(this.containerEl, this.auroraPlugin);
  }

  getSettingDefinitions(): SettingDefinitionItem<AuroraSettingKey>[] {
    return [
      {
        name: "问候名称",
        desc: "可选。留空时首页只显示时段问候。",
        control: {
          type: "text",
          key: "displayName",
          defaultValue: "",
          placeholder: "例如 Sean"
        }
      },
      {
        name: "启动时打开首页",
        desc: "Obsidian 工作区加载完成后自动显示 Dashboard。",
        control: {
          type: "toggle",
          key: "openOnStartup",
          defaultValue: true
        }
      },
      {
        name: "启动方式",
        desc: "替换当前标签更像默认首页；新标签会保留上次打开的笔记。",
        control: {
          type: "dropdown",
          key: "startupMode",
          defaultValue: "replace-active",
          options: {
            "replace-active": "替换当前标签",
            "new-tab": "在新标签打开"
          }
        }
      },
      {
        name: "Todo 文件路径",
        desc: "留空时 Todo 模块为空；填写一个仓库内 Markdown 文件的相对路径后，只读取该文件中的未完成任务。",
        control: {
          type: "text",
          key: "todoFilePath",
          defaultValue: "",
          placeholder: "例如 Todo.md 或 工作/Todo.md"
        }
      },
      {
        name: "空白或极短阈值",
        desc: "字数小于或等于该值时，归入“空白或极短”。",
        control: {
          type: "slider",
          key: "shortNoteWordThreshold",
          defaultValue: 10,
          min: 0,
          max: 100,
          step: 5
        }
      },
      {
        name: "排除文件夹",
        desc: "每行一个仓库相对路径；其子目录也会被排除。",
        control: {
          type: "textarea",
          key: "excludedFolders",
          defaultValue: "",
          placeholder: "模板\n归档/附件",
          rows: 4
        }
      },
      {
        name: "显示估算历史",
        desc: "安装前无法精确还原每日输入量；开启后会按文件当前字数和创建日期估算。",
        control: {
          type: "toggle",
          key: "showEstimatedHistory",
          defaultValue: true
        }
      },
      {
        name: "活动日历范围",
        desc: "控制首页热力日历的统计天数。",
        control: {
          type: "dropdown",
          key: "activityHistoryDays",
          defaultValue: "365",
          options: {
            "90": "最近 90 天",
            "180": "最近 180 天",
            "365": "最近 365 天"
          }
        }
      }
    ];
  }

  getControlValue(key: string): unknown {
    const settings = this.auroraPlugin.data.settings;

    switch (key as AuroraSettingKey) {
      case "displayName":
        return settings.displayName;
      case "openOnStartup":
        return settings.openOnStartup;
      case "startupMode":
        return settings.startupMode;
      case "todoFilePath":
        return settings.todoFilePath;
      case "shortNoteWordThreshold":
        return settings.shortNoteWordThreshold;
      case "excludedFolders":
        return settings.excludedFolders.join("\n");
      case "showEstimatedHistory":
        return settings.showEstimatedHistory;
      case "activityHistoryDays":
        return String(settings.activityHistoryDays);
      default:
        return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.auroraPlugin.data.settings;

    switch (key as AuroraSettingKey) {
      case "displayName":
        if (typeof value === "string") settings.displayName = value.trim();
        break;
      case "openOnStartup":
        if (typeof value === "boolean") settings.openOnStartup = value;
        break;
      case "startupMode":
        if (value === "replace-active" || value === "new-tab") {
          settings.startupMode = value;
        }
        break;
      case "todoFilePath":
        if (typeof value === "string") {
          settings.todoFilePath = normalizeTodoFilePath(value);
        }
        break;
      case "shortNoteWordThreshold":
        if (typeof value === "number" && Number.isFinite(value)) {
          settings.shortNoteWordThreshold = Math.min(100, Math.max(0, value));
        }
        break;
      case "excludedFolders":
        if (typeof value === "string") {
          settings.excludedFolders = parseExcludedFolders(value);
        }
        break;
      case "showEstimatedHistory":
        if (typeof value === "boolean") settings.showEstimatedHistory = value;
        break;
      case "activityHistoryDays": {
        const days = Number(value);
        if (days === 90 || days === 180 || days === 365) {
          settings.activityHistoryDays = days;
        }
        break;
      }
      default:
        return;
    }

    await this.auroraPlugin.saveSettings();
  }
}

export class AuroraSettingsModal extends Modal {
  constructor(
    app: App,
    private readonly auroraPlugin: AuroraDashboardPlugin
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("aurora-settings-modal");
    renderSettings(this.contentEl, this.auroraPlugin, () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function renderSettings(
  container: HTMLElement,
  plugin: AuroraDashboardPlugin,
  close?: () => void
): void {
  container.empty();
  container.createEl("h2", { text: "Dashboard 设置" });
  container.createEl("p", {
    cls: "setting-item-description aurora-settings-intro",
    text: "所有统计与活动记录都只保存在当前仓库，不会发送到网络。"
  });

  new Setting(container)
    .setName("问候名称")
    .setDesc("可选。留空时首页只显示时段问候。")
    .addText((text) =>
      text
        .setPlaceholder("例如 Sean")
        .setValue(plugin.data.settings.displayName)
        .onChange(async (value) => {
          plugin.data.settings.displayName = value.trim();
          await plugin.saveSettings();
        })
    );

  new Setting(container)
    .setName("启动时打开首页")
    .setDesc("Obsidian 工作区加载完成后自动显示 Dashboard。")
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.data.settings.openOnStartup)
        .onChange(async (value) => {
          plugin.data.settings.openOnStartup = value;
          await plugin.saveSettings();
        })
    );

  new Setting(container)
    .setName("启动方式")
    .setDesc("替换当前标签更像默认首页；新标签会保留上次打开的笔记。")
    .addDropdown((dropdown) =>
      dropdown
        .addOption("replace-active", "替换当前标签")
        .addOption("new-tab", "在新标签打开")
        .setValue(plugin.data.settings.startupMode)
        .onChange(async (value) => {
          plugin.data.settings.startupMode = value as StartupMode;
          await plugin.saveSettings();
        })
    );

  new Setting(container)
    .setName("Todo 文件路径")
    .setDesc(
      "留空时 Todo 模块为空；填写仓库内 Markdown 文件的相对路径后，只读取该文件中的未完成任务。"
    )
    .addText((text) =>
      text
        .setPlaceholder("例如 Todo.md 或 工作/Todo.md")
        .setValue(plugin.data.settings.todoFilePath)
        .onChange(async (value) => {
          plugin.data.settings.todoFilePath = normalizeTodoFilePath(value);
          await plugin.saveSettings();
        })
    );

  new Setting(container)
    .setName("空白或极短阈值")
    .setDesc("字数小于或等于该值时，归入“空白或极短”。")
    .addSlider((slider) =>
      slider
        .setLimits(0, 100, 5)
        .setValue(plugin.data.settings.shortNoteWordThreshold)
        .onChange(async (value) => {
          plugin.data.settings.shortNoteWordThreshold = value;
          await plugin.saveSettings();
        })
    );

  new Setting(container)
    .setName("排除文件夹")
    .setDesc("每行一个仓库相对路径；其子目录也会被排除。")
    .addTextArea((text) => {
      text
        .setPlaceholder("模板\n归档/附件")
        .setValue(plugin.data.settings.excludedFolders.join("\n"))
        .onChange(async (value) => {
          plugin.data.settings.excludedFolders = parseExcludedFolders(value);
          await plugin.saveSettings();
        });
      text.inputEl.rows = 4;
    });

  new Setting(container)
    .setName("显示估算历史")
    .setDesc(
      "安装前无法精确还原每日输入量；开启后会按文件当前字数和创建日期估算。"
    )
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.data.settings.showEstimatedHistory)
        .onChange(async (value) => {
          plugin.data.settings.showEstimatedHistory = value;
          await plugin.saveSettings();
        })
    );

  new Setting(container)
    .setName("活动日历范围")
    .setDesc("控制首页热力日历的统计天数。")
    .addDropdown((dropdown) =>
      dropdown
        .addOption("90", "最近 90 天")
        .addOption("180", "最近 180 天")
        .addOption("365", "最近 365 天")
        .setValue(String(plugin.data.settings.activityHistoryDays))
        .onChange(async (value) => {
          plugin.data.settings.activityHistoryDays = Number(value);
          await plugin.saveSettings();
        })
    );

  if (close) {
    const actions = container.createDiv("aurora-settings-actions");
    const done = actions.createEl("button", {
      cls: "mod-cta",
      text: "完成",
      attr: { type: "button" }
    });
    done.addEventListener("click", close);
  }
}

function parseExcludedFolders(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((path) => normalizePath(path.trim()))
    .filter(Boolean);
}
