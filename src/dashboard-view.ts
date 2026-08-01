import { ItemView, Notice, TFile, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import ForceGraph3D from "3d-force-graph";
import type {
  ForceGraph3DInstance,
  LinkObject,
  NodeObject
} from "3d-force-graph";
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Points,
  PointsMaterial
} from "three";
import {
  activityLevel,
  formatCompactNumber,
  localDateKey,
  normalizeTodoFilePath
} from "./core";
import { DetailModal, type DetailItem } from "./detail-modal";
import type AuroraDashboardPlugin from "./main";
import type {
  DailyActivity,
  DailyLinkCount,
  DashboardSnapshot,
  InstalledPlugin,
  KnowledgeGraphSnapshot,
  OpenTask,
  NoteMetric
} from "./models";
import { QuickPluginModal, pluginInitial } from "./quick-plugin-modal";
import { AuroraSettingsModal } from "./settings";

export const VIEW_TYPE_AURORA_DASHBOARD = "aurora-dashboard-view";

export class AuroraDashboardView extends ItemView {
  private refreshTimer: number | null = null;
  private renderDisposers: Array<() => void> = [];

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: AuroraDashboardPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_AURORA_DASHBOARD;
  }

  getDisplayText(): string {
    return "Dashboard";
  }

  getIcon(): string {
    return "layout-dashboard";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("aurora-dashboard-view-content");
    this.renderLoading();
    await this.refresh(true);
  }

  onClose(): Promise<void> {
    this.clearRenderResources();
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    return Promise.resolve();
  }

  requestRefresh(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 900);
  }

  async refresh(force = false): Promise<void> {
    try {
      const [snapshot, installedPlugins] = await Promise.all([
        this.plugin.stats.scan(force),
        this.plugin.getInstalledPlugins()
      ]);
      await this.plugin.initializeQuickPlugins(installedPlugins);
      this.render(snapshot, installedPlugins);
    } catch (error) {
      this.renderError(error);
    }
  }

  private renderLoading(): void {
    this.contentEl.empty();
    const root = this.contentEl.createDiv(
      "aurora-dashboard aurora-dashboard-loading"
    );
    const mark = root.createDiv("aurora-loading-mark");
    setIcon(mark, "loader-circle");
    root.createEl("h2", { text: "正在扫描知识库" });
    root.createEl("p", { text: "首次统计可能需要几秒钟。" });
  }

  private renderError(error: unknown): void {
    this.clearRenderResources();
    this.contentEl.empty();
    const root = this.contentEl.createDiv(
      "aurora-dashboard aurora-dashboard-error"
    );
    const mark = root.createDiv("aurora-error-mark");
    setIcon(mark, "circle-alert");
    root.createEl("h2", { text: "暂时无法生成首页" });
    root.createEl("p", {
      text: error instanceof Error ? error.message : "发生未知错误"
    });
    const retry = root.createEl("button", {
      cls: "mod-cta",
      text: "重新扫描",
      attr: { type: "button" }
    });
    retry.addEventListener("click", () => void this.refresh(true));
  }

  private render(
    snapshot: DashboardSnapshot,
    installedPlugins: InstalledPlugin[]
  ): void {
    this.clearRenderResources();
    this.contentEl.empty();
    const root = this.contentEl.createDiv("aurora-dashboard");

    this.renderHeader(root, snapshot);
    this.renderQuickPlugins(root, installedPlugins);
    this.renderMetrics(root, snapshot);

    const focusGrid = root.createDiv("aurora-dashboard-grid aurora-focus-grid");
    const todoCount = snapshot.taskNotes.reduce(
      (sum, note) => sum + note.tasks.length,
      0
    );
    const todoSurface = this.createSurface(
      focusGrid,
      "Todo",
      this.plugin.data.settings.todoFilePath
        ? `${todoCount} 项未完成`
        : "尚未配置文件"
    );
    todoSurface.addClass("aurora-todo-surface");
    this.renderTodoList(todoSurface, snapshot);

    const graphSurface = this.createSurface(
      focusGrid,
      "知识图谱",
      `${snapshot.graph.nodes.length} 个节点 · ${snapshot.graph.edges.length} 条连接`
    );
    graphSurface.addClass("aurora-graph-surface");
    this.renderGalaxyGraph(graphSurface, snapshot.graph);

    const activitySurface = this.createSurface(
      focusGrid,
      "写作活动",
      this.activitySubtitle()
    );
    activitySurface.addClass("aurora-activity-surface");
    this.renderHeatmap(activitySurface, snapshot);

    const currentLinkCount = snapshot.linkHistory.at(-1)?.count ?? 0;
    const linkSurface = this.createSurface(
      focusGrid,
      "双链数量",
      `365 天 · ${formatCompactNumber(currentLinkCount)}`
    );
    linkSurface.addClass("aurora-link-surface");
    this.renderLinkChart(linkSurface, snapshot.linkHistory);

    const issuesSurface = this.createSurface(
      root,
      "待整理",
      "点击查看具体笔记"
    );
    issuesSurface.addClass("aurora-issues-surface");
    this.renderIssues(issuesSurface, snapshot);

    const lowerGrid = root.createDiv("aurora-dashboard-grid aurora-lower-grid");
    const trendSurface = this.createSurface(
      lowerGrid,
      "每日新增字数",
      "过去 30 天"
    );
    trendSurface.addClass("aurora-trend-surface");
    this.renderTrendChart(trendSurface, snapshot.trend);

    const recentSurface = this.createSurface(
      lowerGrid,
      "最近笔记",
      `${snapshot.modifiedToday} 篇今日修改`
    );
    recentSurface.addClass("aurora-recent-surface");
    this.renderRecentNotes(recentSurface, snapshot);

    const structureSurface = this.createSurface(
      root,
      "文件结构",
      "按一级目录统计 Markdown 笔记"
    );
    structureSurface.addClass("aurora-structure-surface");
    this.renderStructure(structureSurface, snapshot);

    const footer = root.createDiv("aurora-dashboard-footer");
    const scope = footer.createSpan({
      text: `统计范围：${snapshot.noteCount} 篇 Markdown 笔记`
    });
    scope.setAttr("aria-label", "统计范围");
    footer.createSpan({
      text: this.plugin.data.settings.showEstimatedHistory
        ? "写作活动包含安装前估算数据"
        : "仅显示安装后的精确活动"
    });
  }

  private renderQuickPlugins(
    root: HTMLElement,
    installedPlugins: InstalledPlugin[]
  ): void {
    const section = root.createDiv("aurora-quick-plugins");
    const label = section.createSpan("aurora-quick-plugins-label");
    label.createSpan({ text: "快捷插件" });
    const scroller = section.createDiv("aurora-quick-plugins-scroll");
    this.listen(scroller, "wheel", (event) => {
      if (
        scroller.scrollWidth > scroller.clientWidth &&
        Math.abs(event.deltaY) > Math.abs(event.deltaX)
      ) {
        scroller.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    });
    const byId = new Map(
      installedPlugins.map((plugin) => [plugin.id, plugin])
    );
    const selected = this.plugin.data.settings.quickPluginIds
      .map((id) => byId.get(id))
      .filter((plugin): plugin is InstalledPlugin => plugin !== undefined);

    if (selected.length === 0) {
      scroller.createSpan({
        cls: "aurora-quick-plugins-empty",
        text: "添加常用插件入口"
      });
    } else {
      selected.forEach((plugin) => {
        const link = scroller.createEl("a", {
          cls: "aurora-plugin-shortcut",
          href: `obsidian://show-plugin?id=${encodeURIComponent(plugin.id)}`,
          attr: {
            "aria-label": `打开 ${plugin.name}`,
            title: plugin.description || plugin.name
          }
        });
        link.createSpan({
          cls: "aurora-plugin-shortcut-mark",
          text: pluginInitial(plugin.name)
        });
        link.createSpan({
          cls: "aurora-plugin-shortcut-name",
          text: plugin.name
        });
      });
    }

    const manage = this.createIconButton(section, "sliders-horizontal", "管理快捷插件");
    manage.addClass("aurora-quick-plugins-manage");
    this.listen(manage, "click", () => {
      new QuickPluginModal(this.app, this.plugin).open();
    });
  }

  private renderHeader(
    root: HTMLElement,
    snapshot: DashboardSnapshot
  ): void {
    const header = root.createDiv("aurora-dashboard-header");
    const copy = header.createDiv("aurora-dashboard-heading");
    const displayName = this.plugin.data.settings.displayName;
    copy.createEl("h1", {
      text: `${greeting()}${displayName ? `，${displayName}` : ""}`
    });
    copy.createEl("p", {
      text: `${this.app.vault.getName()} · ${snapshot.noteCount} 篇笔记 · ${formatUpdatedTime(snapshot.generatedAt)}`
    });

    const actions = header.createDiv("aurora-dashboard-actions");
    const refresh = this.createIconButton(actions, "refresh-cw", "重新扫描");
    this.listen(refresh, "click", () => {
      refresh.addClass("is-spinning");
      void this.refresh(true).finally(() => refresh.removeClass("is-spinning"));
    });
    const settings = this.createIconButton(actions, "settings", "打开设置");
    this.listen(settings, "click", () => {
      new AuroraSettingsModal(this.app, this.plugin).open();
    });
  }

  private renderMetrics(root: HTMLElement, snapshot: DashboardSnapshot): void {
    const metrics = root.createDiv("aurora-metrics");
    this.createMetricCard(
      metrics,
      "files",
      formatCompactNumber(snapshot.noteCount),
      "笔记",
      "accent-blue",
      () =>
        this.openDetails(
          "全部笔记",
          "按最近修改时间排序",
          [...snapshot.notes]
            .sort((a, b) => b.file.stat.mtime - a.file.stat.mtime)
            .map((note) => noteDetail(note, `${note.words} 字`))
        )
    );
    this.createMetricCard(
      metrics,
      "type",
      formatCompactNumber(snapshot.totalWords),
      "总字数",
      "accent-green",
      () =>
        this.openDetails(
          "字数明细",
          "中文字符与其他语言词组按可读文本统计",
          [...snapshot.notes]
            .sort((a, b) => b.words - a.words)
            .map((note) => noteDetail(note, `${note.words} 字`))
        )
    );
    this.createMetricCard(
      metrics,
      "link",
      formatCompactNumber(snapshot.unlinkedNotes.length),
      "待连接",
      "accent-yellow",
      () =>
        this.openDetails(
          "无反向链接笔记",
          "这些笔记尚未被其他笔记引用",
          snapshot.unlinkedNotes.map((note) =>
            noteDetail(note, `${note.outgoingLinks} 个出链`)
          )
        )
    );
    this.createMetricCard(
      metrics,
      "file-warning",
      formatCompactNumber(snapshot.shortNotes.length),
      "空白或极短",
      "accent-purple",
      () =>
        this.openDetails(
          "空白或极短笔记",
          `当前阈值：不超过 ${this.plugin.data.settings.shortNoteWordThreshold} 字`,
          snapshot.shortNotes.map((note) =>
            noteDetail(note, `${note.words} 字`)
          )
        )
    );
  }

  private renderTodoList(
    surface: HTMLElement,
    snapshot: DashboardSnapshot
  ): void {
    const list = surface.createDiv("aurora-todo-list");
    const configuredPath = normalizeTodoFilePath(
      this.plugin.data.settings.todoFilePath
    );
    const todos = snapshot.taskNotes.flatMap((note) =>
      note.tasks.map((task) => ({ file: note.file, task }))
    );

    if (!configuredPath) {
      this.renderTodoEmpty(
        list,
        "file-cog",
        "尚未配置 Todo 文件",
        "在设置中填写一个仓库内 Markdown 文件路径。"
      );
      return;
    }

    if (todos.length === 0) {
      const configuredFile = this.app.vault.getAbstractFileByPath(configuredPath);
      this.renderTodoEmpty(
        list,
        configuredFile instanceof TFile ? "circle-check-big" : "file-warning",
        configuredFile instanceof TFile
          ? "这个文件中没有未完成任务"
          : "未找到配置的 Todo 文件",
        configuredFile instanceof TFile ? configuredPath : `请检查路径：${configuredPath}`
      );
      return;
    }

    todos.slice(0, 7).forEach(({ file, task }) => {
      const row = list.createDiv("aurora-todo-row");
      const complete = row.createEl("button", {
        cls: "aurora-todo-check",
        attr: {
          type: "button",
          "aria-label": `完成任务：${task.text}`,
          title: "标记为已完成"
        }
      });
      setIcon(complete, "circle");
      this.listen(complete, "click", () => {
        void this.saveTodoUpdate(file, task, { completed: true }, complete);
      });

      const copy = row.createDiv("aurora-todo-copy");
      const input = copy.createEl("input", {
        cls: "aurora-todo-input",
        value: task.text,
        attr: {
          type: "text",
          "aria-label": `编辑任务：${task.text}`
        }
      });
      copy.createSpan({
        cls: "aurora-todo-path",
        text: `${file.basename} · 第 ${task.line + 1} 行`
      });
      const commit = (): void => {
        const value = input.value.trim();
        if (!value || value === task.text) {
          input.value = task.text;
          return;
        }
        void this.saveTodoUpdate(file, task, { text: value }, input);
      };
      this.listen(input, "blur", commit);
      this.listen(input, "keydown", (event) => {
        if (event.key === "Enter") input.blur();
        if (event.key === "Escape") {
          input.value = task.text;
          input.blur();
        }
      });

      const open = this.createIconButton(row, "external-link", "打开任务笔记");
      open.addClass("aurora-todo-open");
      this.listen(open, "click", () => {
        void this.app.workspace.getLeaf(false).openFile(file);
      });
    });

    if (todos.length > 7) {
      const more = list.createEl("button", {
        cls: "aurora-todo-more",
        text: `查看其余 ${todos.length - 7} 项`,
        attr: { type: "button" }
      });
      this.listen(more, "click", () => {
        this.openDetails(
          "未完成任务",
          "点击任务可打开对应笔记",
          todos.map(({ file, task }) => ({
            file,
            title: task.text,
            subtitle: file.path,
            badge: `第 ${task.line + 1} 行`
          }))
        );
      });
    }
  }

  private renderTodoEmpty(
    list: HTMLElement,
    iconName: string,
    title: string,
    description: string
  ): void {
    const empty = list.createDiv("aurora-todo-empty");
    const icon = empty.createSpan();
    setIcon(icon, iconName);
    empty.createSpan({ cls: "aurora-todo-empty-title", text: title });
    empty.createSpan({ cls: "aurora-todo-empty-description", text: description });
    const configure = empty.createEl("button", {
      text: "配置 Todo 文件",
      attr: { type: "button" }
    });
    this.listen(configure, "click", () => {
      new AuroraSettingsModal(this.app, this.plugin).open();
    });
  }

  private async saveTodoUpdate(
    file: TFile,
    task: OpenTask,
    update: { completed?: boolean; text?: string },
    control: HTMLElement
  ): Promise<void> {
    control.addClass("is-saving");
    if (control instanceof HTMLInputElement || control instanceof HTMLButtonElement) {
      control.disabled = true;
    }
    try {
      await this.plugin.updateTask(file, task, update);
      await this.refresh(true);
    } catch (error) {
      new Notice(
        error instanceof Error ? error.message : "任务更新失败，请刷新后重试"
      );
      control.removeClass("is-saving");
      if (
        control instanceof HTMLInputElement ||
        control instanceof HTMLButtonElement
      ) {
        control.disabled = false;
      }
    }
  }

  private renderGalaxyGraph(
    surface: HTMLElement,
    snapshot: KnowledgeGraphSnapshot
  ): void {
    const body = surface.createDiv("aurora-galaxy-graph");
    if (snapshot.nodes.length === 0) {
      body.createDiv({ cls: "aurora-empty-state", text: "还没有可展示的连接" });
      return;
    }

    const nodes: GalaxyNode[] = snapshot.nodes.map((node) => ({
      id: node.file.path,
      file: node.file,
      degree: node.degree,
      color: galaxyColor(node.file.path),
      val: Math.max(1.1, Math.log2(node.degree + 2))
    }));
    const links: GalaxyLink[] = snapshot.edges.map((edge) => ({
      source: edge.source,
      target: edge.target
    }));
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    try {
      const graph = new ForceGraph3D(body, {
        controlType: "orbit",
        rendererConfig: {
          alpha: true,
          antialias: true,
          powerPreference: "high-performance"
        }
      }) as unknown as ForceGraph3DInstance<GalaxyNode, GalaxyLink>;
      const focusGraph = (duration: number): void => {
        graph.zoomToFit(0, 12);
        const camera = graph.cameraPosition();
        graph.cameraPosition(
          {
            x: camera.x * 0.25,
            y: camera.y * 0.25,
            z: camera.z * 0.25
          },
          { x: 0, y: 0, z: 0 },
          duration
        );
      };
      graph
        .warmupTicks(70)
        .cooldownTicks(150)
        .graphData({ nodes, links })
        .backgroundColor("rgba(5, 6, 18, 0.98)")
        .showNavInfo(false)
        .nodeId("id")
        .nodeLabel((node) =>
          `${escapeHtml(node.file.basename)}<br><span>${node.degree} 个连接</span>`
        )
        .nodeColor((node) => node.color)
        .nodeVal((node) => node.val)
        .nodeRelSize(3.2)
        .nodeOpacity(0.92)
        .nodeResolution(10)
        .linkColor(() => "#a996ff")
        .linkOpacity(0.46)
        .linkWidth(0.72)
        .linkDirectionalParticles(reduceMotion ? 0 : 1)
        .linkDirectionalParticleColor(() => "#ff4f9a")
        .linkDirectionalParticleWidth(1.15)
        .linkDirectionalParticleSpeed(0.0036)
        .onNodeClick((node) => {
          void this.app.workspace.getLeaf(false).openFile(node.file);
        })
        .onEngineStop(() => focusGraph(650));

      const stars = createGalaxyStars(900);
      graph.scene().add(stars);
      graph.cameraPosition({ z: 560 });

      const resize = (): void => {
        graph
          .width(Math.max(300, body.clientWidth))
          .height(Math.max(340, body.clientHeight));
      };
      const observer = new ResizeObserver(resize);
      observer.observe(body);
      resize();
      const focusTimer = window.setTimeout(() => {
        focusGraph(800);
      }, 900);

      let animationFrame = 0;
      const animateStars = (): void => {
        stars.rotation.y += 0.00045;
        stars.rotation.x += 0.00008;
        animationFrame = window.requestAnimationFrame(animateStars);
      };
      if (!reduceMotion) animateStars();

      this.renderDisposers.push(() => {
        observer.disconnect();
        window.clearTimeout(focusTimer);
        if (animationFrame) window.cancelAnimationFrame(animationFrame);
        graph.scene().remove(stars);
        stars.geometry.dispose();
        stars.material.dispose();
        graph._destructor();
      });
    } catch (error) {
      body.empty();
      body.createDiv({
        cls: "aurora-empty-state",
        text:
          error instanceof Error
            ? `3D 图谱加载失败：${error.message}`
            : "3D 图谱加载失败"
      });
    }
  }

  private renderHeatmap(
    surface: HTMLElement,
    snapshot: DashboardSnapshot
  ): void {
    const values = snapshot.activity
      .map((day) => day.addedWords)
      .filter((value) => value > 0)
      .sort((a, b) => a - b);
    const max =
      values[Math.max(0, Math.floor(values.length * 0.9) - 1)] ??
      values.at(-1) ??
      1;
    const today = localDateKey(new Date());
    const grid = surface.createDiv("aurora-heatmap-grid");
    grid.dataset.range = String(
      this.plugin.data.settings.activityHistoryDays
    );
    snapshot.activity.forEach((day) => {
      const cell = grid.createEl("button", {
        cls: "aurora-heatmap-cell",
        attr: {
          type: "button",
          "aria-label": activityAriaLabel(day)
        }
      });
      cell.dataset.level = String(activityLevel(day.addedWords, max));
      if (day.estimated) cell.addClass("is-estimated");
      if (day.date === today) cell.addClass("is-today");
      this.listen(cell, "click", () => this.openActivityDay(day));
    });

    const legend = surface.createDiv("aurora-heatmap-legend");
    legend.createSpan({ text: "少" });
    for (let level = 1; level <= 5; level += 1) {
      const swatch = legend.createSpan("aurora-heatmap-swatch");
      swatch.dataset.level = String(level);
    }
    legend.createSpan({ text: "多" });
  }

  private renderIssues(
    surface: HTMLElement,
    snapshot: DashboardSnapshot
  ): void {
    const list = surface.createDiv("aurora-issue-list");
    this.createIssueRow(
      list,
      "square-check-big",
      "Todo 文件未完成任务",
      snapshot.taskNotes.reduce((sum, note) => sum + note.tasks.length, 0),
      () => {
        if (!this.plugin.data.settings.todoFilePath) {
          new AuroraSettingsModal(this.app, this.plugin).open();
          return;
        }
        const items = snapshot.taskNotes.flatMap((note) =>
          note.tasks.map((task) => ({
            file: note.file,
            title: task.text,
            subtitle: note.file.path,
            badge: `第 ${task.line + 1} 行`
          }))
        );
        this.openDetails(
          "未完成任务",
          `来源：${this.plugin.data.settings.todoFilePath}`,
          items
        );
      }
    );
    this.createIssueRow(
      list,
      "unlink",
      "无反向链接笔记",
      snapshot.unlinkedNotes.length,
      () =>
        this.openDetails(
          "无反向链接笔记",
          "这些笔记尚未被其他笔记引用",
          snapshot.unlinkedNotes.map((note) =>
            noteDetail(note, `${note.outgoingLinks} 个出链`)
          )
        )
    );
    this.createIssueRow(
      list,
      "file-warning",
      "空白或极短笔记",
      snapshot.shortNotes.length,
      () =>
        this.openDetails(
          "空白或极短笔记",
          `当前阈值：不超过 ${this.plugin.data.settings.shortNoteWordThreshold} 字`,
          snapshot.shortNotes.map((note) =>
            noteDetail(note, `${note.words} 字`)
          )
        )
    );
  }

  private renderLinkChart(
    surface: HTMLElement,
    history: DailyLinkCount[]
  ): void {
    const chartWrap = surface.createDiv("aurora-link-chart-wrap");
    const canvas = chartWrap.createEl("canvas", {
      cls: "aurora-link-chart",
      attr: {
        role: "img",
        "aria-label": "过去 365 天累计双链数量折线面积图"
      }
    });
    const tooltip = chartWrap.createDiv("aurora-chart-tooltip");
    tooltip.hide();
    const draw = (): ChartGeometry =>
      drawLinkChart(canvas, history, surface);
    let geometry = draw();
    const observer = new ResizeObserver(() => {
      geometry = draw();
    });
    observer.observe(chartWrap);
    this.renderDisposers.push(() => observer.disconnect());

    this.listen(canvas, "mousemove", (event) => {
      if (history.length === 0 || geometry.points.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const index = nearestPointIndex(
        geometry.points,
        event.clientX - rect.left
      );
      const point = geometry.points[index];
      const day = history[index];
      if (!point || !day) return;
      tooltip.empty();
      tooltip.createSpan({
        cls: "aurora-chart-tooltip-date",
        text: formatDateLabel(day.date)
      });
      tooltip.createSpan({
        text: `${new Intl.NumberFormat("zh-CN").format(day.count)} 条累计双链`
      });
      if (day.estimated) {
        tooltip.createSpan({
          cls: "aurora-chart-tooltip-source",
          text: "按源笔记修改日期估算"
        });
      }
      tooltip.setCssProps({
        "--aurora-tooltip-left": `${Math.min(rect.width - 145, Math.max(8, point.x - 55))}px`,
        "--aurora-tooltip-top": `${Math.max(8, point.y - 66)}px`
      });
      tooltip.show();
    });
    this.listen(canvas, "mouseleave", () => tooltip.hide());

    chartWrap.createDiv({
      cls: "aurora-link-chart-note",
      text: history.some((day) => day.estimated)
        ? "历史按源笔记最后修改日期估算"
        : "每日精确快照"
    });
  }

  private renderTrendChart(
    surface: HTMLElement,
    trend: DailyActivity[]
  ): void {
    const chartWrap = surface.createDiv("aurora-chart-wrap");
    const canvas = chartWrap.createEl("canvas", {
      cls: "aurora-trend-chart",
      attr: { role: "img", "aria-label": "过去 30 天每日新增字数折线图" }
    });
    const tooltip = chartWrap.createDiv("aurora-chart-tooltip");
    tooltip.hide();
    const draw = (): ChartGeometry =>
      drawTrendChart(canvas, trend, surface);
    let geometry = draw();
    const observer = new ResizeObserver(() => {
      geometry = draw();
    });
    observer.observe(chartWrap);
    this.renderDisposers.push(() => observer.disconnect());

    this.listen(canvas, "mousemove", (event) => {
      if (trend.length === 0 || geometry.points.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const index = nearestPointIndex(geometry.points, x);
      const point = geometry.points[index];
      const day = trend[index];
      if (!point || !day) return;
      tooltip.empty();
      tooltip.createSpan({
        cls: "aurora-chart-tooltip-date",
        text: formatDateLabel(day.date)
      });
      tooltip.createSpan({
        text: `${new Intl.NumberFormat("zh-CN").format(day.addedWords)} 字`
      });
      tooltip.setCssProps({
        "--aurora-tooltip-left": `${Math.min(rect.width - 120, Math.max(8, point.x - 42))}px`,
        "--aurora-tooltip-top": `${Math.max(8, point.y - 54)}px`
      });
      tooltip.show();
    });
    this.listen(canvas, "mouseleave", () => tooltip.hide());
    this.listen(canvas, "click", (event) => {
      const rect = canvas.getBoundingClientRect();
      const index = nearestPointIndex(
        geometry.points,
        event.clientX - rect.left
      );
      const day = trend[index];
      if (day) this.openActivityDay(day);
    });

    const chartFooter = surface.createDiv("aurora-chart-footer");
    const latest = trend.at(-1);
    chartFooter.createSpan({
      text: latest
        ? `今日 ${new Intl.NumberFormat("zh-CN").format(latest.addedWords)} 字`
        : "暂无活动"
    });
    if (trend.some((day) => day.estimated)) {
      chartFooter.createSpan({
        cls: "aurora-estimate-label",
        text: "含估算历史"
      });
    }
  }

  private renderRecentNotes(
    surface: HTMLElement,
    snapshot: DashboardSnapshot
  ): void {
    const list = surface.createDiv("aurora-recent-list");
    if (snapshot.recentNotes.length === 0) {
      list.createDiv({ cls: "aurora-empty-state", text: "还没有笔记" });
      return;
    }
    snapshot.recentNotes.slice(0, 5).forEach((note) => {
      const row = list.createEl("button", {
        cls: "aurora-recent-row",
        attr: { type: "button" }
      });
      const icon = row.createSpan("aurora-recent-icon");
      setIcon(icon, "file-text");
      const copy = row.createSpan("aurora-recent-copy");
      copy.createSpan({
        cls: "aurora-recent-title",
        text: note.file.basename
      });
      copy.createSpan({
        cls: "aurora-recent-path",
        text: note.file.parent?.path ?? "/"
      });
      row.createSpan({
        cls: "aurora-recent-time",
        text: relativeTime(note.file.stat.mtime)
      });
      const arrow = row.createSpan("aurora-row-arrow");
      setIcon(arrow, "chevron-right");
      this.listen(row, "click", () => {
        void this.app.workspace.getLeaf(false).openFile(note.file);
      });
    });
  }

  private renderStructure(
    surface: HTMLElement,
    snapshot: DashboardSnapshot
  ): void {
    const list = surface.createDiv("aurora-structure-list");
    const maxCount = snapshot.folders[0]?.noteCount ?? 1;
    snapshot.folders.slice(0, 8).forEach((folder, index) => {
      const row = list.createEl("button", {
        cls: "aurora-structure-row",
        attr: { type: "button" }
      });
      const icon = row.createSpan("aurora-structure-icon");
      setIcon(icon, "folder");
      const copy = row.createSpan("aurora-structure-copy");
      const heading = copy.createSpan("aurora-structure-heading");
      heading.createSpan({
        cls: "aurora-structure-name",
        text: folder.name
      });
      heading.createSpan({
        cls: "aurora-structure-count",
        text: `${folder.noteCount} 篇`
      });
      const bar = copy.createSpan("aurora-structure-bar");
      const fill = bar.createSpan("aurora-structure-bar-fill");
      fill.dataset.color = String((index % 5) + 1);
      fill.setCssProps({
        "--aurora-structure-fill-width": `${Math.max(3, (folder.noteCount / maxCount) * 100)}%`
      });
      row.createSpan({
        cls: "aurora-structure-words",
        text: `${formatCompactNumber(folder.wordCount)} 字`
      });
      const arrow = row.createSpan("aurora-row-arrow");
      setIcon(arrow, "chevron-right");
      this.listen(row, "click", () => {
        const metricsByPath = new Map(
          snapshot.notes.map((note) => [note.file.path, note])
        );
        this.openDetails(
          folder.name,
          `${folder.noteCount} 篇笔记 · ${formatCompactNumber(folder.wordCount)} 字`,
          folder.files.map((file) => {
            const metric = metricsByPath.get(file.path);
            return {
              file,
              subtitle: file.path,
              badge: metric ? `${metric.words} 字` : undefined
            };
          })
        );
      });
    });
  }

  private createSurface(
    parent: HTMLElement,
    title: string,
    subtitle: string
  ): HTMLElement {
    const surface = parent.createDiv("aurora-surface");
    const header = surface.createDiv("aurora-surface-header");
    header.createEl("h2", { text: title });
    header.createSpan({ text: subtitle });
    return surface;
  }

  private createMetricCard(
    parent: HTMLElement,
    iconName: string,
    value: string,
    label: string,
    colorClass: string,
    onClick: () => void
  ): void {
    const button = parent.createEl("button", {
      cls: `aurora-metric ${colorClass}`,
      attr: { type: "button", "aria-label": `${label}：${value}` }
    });
    const icon = button.createSpan("aurora-metric-icon");
    setIcon(icon, iconName);
    const copy = button.createSpan("aurora-metric-copy");
    copy.createSpan({ cls: "aurora-metric-value", text: value });
    copy.createSpan({ cls: "aurora-metric-label", text: label });
    const arrow = button.createSpan("aurora-row-arrow");
    setIcon(arrow, "chevron-right");
    this.listen(button, "click", onClick);
  }

  private createIssueRow(
    parent: HTMLElement,
    iconName: string,
    label: string,
    count: number,
    onClick: () => void
  ): void {
    const row = parent.createEl("button", {
      cls: "aurora-issue-row",
      attr: { type: "button" }
    });
    const icon = row.createSpan("aurora-issue-icon");
    setIcon(icon, iconName);
    row.createSpan({ cls: "aurora-issue-label", text: label });
    row.createSpan({
      cls: "aurora-issue-count",
      text: new Intl.NumberFormat("zh-CN").format(count)
    });
    const arrow = row.createSpan("aurora-row-arrow");
    setIcon(arrow, "chevron-right");
    this.listen(row, "click", onClick);
  }

  private createIconButton(
    parent: HTMLElement,
    iconName: string,
    label: string
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "aurora-icon-button",
      attr: { type: "button", "aria-label": label, title: label }
    });
    setIcon(button, iconName);
    return button;
  }

  private openDetails(
    title: string,
    description: string,
    items: DetailItem[]
  ): void {
    new DetailModal(this.app, title, description, items).open();
  }

  private openActivityDay(day: DailyActivity): void {
    this.openDetails(
      formatDateLabel(day.date),
      `${new Intl.NumberFormat("zh-CN").format(day.addedWords)} 字 · ${day.edits} 次编辑${day.estimated ? " · 估算" : ""}`,
      day.files.map((file) => ({ file, subtitle: file.path }))
    );
  }

  private activitySubtitle(): string {
    const days = this.plugin.data.settings.activityHistoryDays;
    if (days >= 365) return "过去 12 个月";
    if (days >= 180) return "过去 6 个月";
    return `过去 ${days} 天`;
  }

  private listen<K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    eventName: K,
    handler: (event: HTMLElementEventMap[K]) => void
  ): void {
    element.addEventListener(eventName, handler);
    this.renderDisposers.push(() =>
      element.removeEventListener(eventName, handler)
    );
  }

  private clearRenderResources(): void {
    this.renderDisposers.forEach((dispose) => dispose());
    this.renderDisposers = [];
  }
}

interface GalaxyNode extends NodeObject {
  id: string;
  file: TFile;
  degree: number;
  color: string;
  val: number;
}

interface GalaxyLink extends LinkObject<GalaxyNode> {
  source: string | GalaxyNode;
  target: string | GalaxyNode;
}

interface ChartPoint {
  x: number;
  y: number;
}

interface ChartGeometry {
  points: ChartPoint[];
}

function createGalaxyStars(
  count: number
): Points<BufferGeometry, PointsMaterial> {
  const positions: number[] = [];
  const colors: number[] = [];
  const palette = ["#f8f5ff", "#ff63a7", "#a884ff", "#66d9ff"];
  let seed = 0x51f15e;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let index = 0; index < count; index += 1) {
    const radius = 250 + random() * 850;
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    positions.push(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi)
    );
    const color = new Color(palette[Math.floor(random() * palette.length)]);
    colors.push(color.r, color.g, color.b);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  const material = new PointsMaterial({
    size: 1.65,
    transparent: true,
    opacity: 0.78,
    vertexColors: true,
    blending: AdditiveBlending,
    depthWrite: false
  });
  return new Points(geometry, material);
}

function galaxyColor(path: string): string {
  const palette = ["#ff4f9a", "#b78cff", "#6dd6ff", "#f4a4d2", "#f7d76d"];
  return palette[stableHash(path) % palette.length]!;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#039;");
}

function drawTrendChart(
  canvas: HTMLCanvasElement,
  trend: DailyActivity[],
  tokenRoot: HTMLElement
): ChartGeometry {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, rect.width);
  const height = Math.max(190, rect.height);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  if (!context) return { points: [] };
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const style = getComputedStyle(tokenRoot);
  const gridColor =
    style.getPropertyValue("--aurora-chart-grid").trim() ||
    "rgba(136, 152, 170, 0.18)";
  const lineColor =
    style.getPropertyValue("--aurora-accent-blue").trim() || "#88c0d0";
  const textColor =
    style.getPropertyValue("--aurora-text-muted").trim() || "#a3adba";
  const padding = { top: 18, right: 18, bottom: 30, left: 45 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(1, ...trend.map((day) => day.addedWords));
  const roundedMax = roundChartMax(maxValue);

  context.font =
    "11px var(--font-interface, -apple-system, BlinkMacSystemFont, sans-serif)";
  context.textBaseline = "middle";
  context.strokeStyle = gridColor;
  context.fillStyle = textColor;
  context.lineWidth = 1;
  for (let step = 0; step <= 4; step += 1) {
    const y = padding.top + (plotHeight / 4) * step;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    const value = roundedMax - (roundedMax / 4) * step;
    context.textAlign = "right";
    context.fillText(shortAxisNumber(value), padding.left - 9, y);
  }

  const points = trend.map((day, index) => {
    const x =
      padding.left +
      (trend.length <= 1 ? 0 : (plotWidth * index) / (trend.length - 1));
    const y =
      padding.top + plotHeight * (1 - day.addedWords / roundedMax);
    return { x, y };
  });

  if (points.length > 0) {
    context.strokeStyle = lineColor;
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.stroke();

    points.forEach((point, index) => {
      if (index % 3 !== 0 && index !== points.length - 1) return;
      context.fillStyle = lineColor;
      context.beginPath();
      context.arc(point.x, point.y, index === points.length - 1 ? 4 : 2.5, 0, Math.PI * 2);
      context.fill();
    });
  }

  context.fillStyle = textColor;
  context.textAlign = "center";
  [0, 7, 14, 21, 29].forEach((index) => {
    const day = trend[index];
    const point = points[index];
    if (!day || !point) return;
    context.fillText(formatShortDate(day.date), point.x, height - 10);
  });

  return { points };
}

function drawLinkChart(
  canvas: HTMLCanvasElement,
  history: DailyLinkCount[],
  tokenRoot: HTMLElement
): ChartGeometry {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(220, rect.width);
  const height = Math.max(190, rect.height);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  if (!context) return { points: [] };
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const style = getComputedStyle(tokenRoot);
  const gridColor =
    style.getPropertyValue("--aurora-chart-grid").trim() ||
    "rgba(136, 152, 170, 0.18)";
  const lineColor =
    style.getPropertyValue("--aurora-accent-purple").trim() || "#b48ead";
  const areaColor =
    style.getPropertyValue("--aurora-link-area").trim() ||
    "rgba(180, 142, 173, 0.22)";
  const textColor =
    style.getPropertyValue("--aurora-text-muted").trim() || "#a3adba";
  const padding = { top: 18, right: 14, bottom: 31, left: 39 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(1, ...history.map((day) => day.count));
  const roundedMax = roundChartMax(maxValue);

  context.font =
    "10px var(--font-interface, -apple-system, BlinkMacSystemFont, sans-serif)";
  context.textBaseline = "middle";
  context.strokeStyle = gridColor;
  context.fillStyle = textColor;
  context.lineWidth = 1;
  for (let step = 0; step <= 4; step += 1) {
    const y = padding.top + (plotHeight / 4) * step;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    const value = roundedMax - (roundedMax / 4) * step;
    context.textAlign = "right";
    context.fillText(shortAxisNumber(value), padding.left - 7, y);
  }

  const points = history.map((day, index) => ({
    x:
      padding.left +
      (history.length <= 1 ? 0 : (plotWidth * index) / (history.length - 1)),
    y: padding.top + plotHeight * (1 - day.count / roundedMax)
  }));

  if (points.length > 0) {
    const first = points[0]!;
    const last = points.at(-1)!;
    context.fillStyle = areaColor;
    context.beginPath();
    context.moveTo(first.x, padding.top + plotHeight);
    points.forEach((point) => context.lineTo(point.x, point.y));
    context.lineTo(last.x, padding.top + plotHeight);
    context.closePath();
    context.fill();

    context.strokeStyle = lineColor;
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.stroke();

    context.fillStyle = lineColor;
    context.beginPath();
    context.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
    context.fill();
  }

  context.fillStyle = textColor;
  context.textAlign = "center";
  const tickIndexes = [
    0,
    Math.floor((history.length - 1) / 2),
    Math.max(0, history.length - 1)
  ];
  [...new Set(tickIndexes)].forEach((index) => {
    const day = history[index];
    const point = points[index];
    if (!day || !point) return;
    context.fillText(formatShortDate(day.date), point.x, height - 10);
  });

  return { points };
}

function nearestPointIndex(points: ChartPoint[], x: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => {
    const distance = Math.abs(point.x - x);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function roundChartMax(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function shortAxisNumber(value: number): string {
  if (value >= 1000) {
    const scaled = value / 1000;
    return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/u, "")}k`;
  }
  return String(Math.round(value));
}

function noteDetail(note: NoteMetric, badge?: string): DetailItem {
  return {
    file: note.file,
    title: note.file.basename,
    subtitle: note.file.path,
    badge
  };
}

function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 6) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function formatUpdatedTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚更新";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前更新`;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

function relativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric"
  }).format(timestamp);
}

function formatDateLabel(date: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short"
  }).format(new Date(`${date}T00:00:00`));
}

function formatShortDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  return `${parsed.getMonth() + 1}-${parsed.getDate()}`;
}

function activityAriaLabel(day: DailyActivity): string {
  const source = day.estimated ? "，估算数据" : "";
  return `${formatDateLabel(day.date)}，${day.addedWords} 字，${day.edits} 次编辑${source}`;
}
