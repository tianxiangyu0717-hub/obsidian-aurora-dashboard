import { ItemView, Notice, TFile, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
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
  private galaxyGraphResource: GalaxyGraphResource | null = null;

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
    this.disposeGalaxyGraph();
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
    this.disposeGalaxyGraph();
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
    const graphKey = knowledgeGraphKey(snapshot);
    if (this.galaxyGraphResource?.key === graphKey) {
      surface.appendChild(this.galaxyGraphResource.body);
      return;
    }

    this.disposeGalaxyGraph();
    const body = surface.createDiv("aurora-galaxy-graph");
    if (snapshot.nodes.length === 0) {
      body.createDiv({ cls: "aurora-empty-state", text: "还没有可展示的连接" });
      return;
    }

    const nodes: GalaxyNode[] = snapshot.nodes.map((node) => ({
      id: node.file.path,
      file: node.file,
      degree: node.degree,
      color: galaxyColor(node.file.path)
    }));
    const links: GalaxyLink[] = snapshot.edges.map((edge) => ({
      source: edge.source,
      target: edge.target
    }));
    // Keep this renderer Canvas 2D-only. A second WebGL graph in Obsidian's
    // Electron renderer can evict the native graph's GPU context.
    const scene = createGalaxyScene(nodes, links);
    const canvas = body.createEl("canvas", {
      cls: "aurora-galaxy-canvas",
      attr: {
        role: "img",
        "aria-label": "可旋转和缩放的 3D 星河知识图谱"
      }
    });
    const tooltip = body.createDiv("aurora-galaxy-tooltip");
    tooltip.hide();
    let points: GalaxyCanvasPoint[] = [];
    const camera: GalaxyCamera = {
      yaw: -0.42,
      pitch: 0.18,
      zoom: 1.18
    };
    let animationFrame = 0;
    let lastFrame = 0;
    let visible = true;
    let disposed = false;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    const draw = (time = performance.now()): void => {
      points = drawGalaxyCanvas(
        canvas,
        scene,
        camera,
        reduceMotion ? 0 : time / 1000
      );
      lastFrame = time;
    };
    const scheduleAnimation = (): void => {
      if (
        disposed ||
        reduceMotion ||
        !visible ||
        document.hidden ||
        animationFrame !== 0
      ) {
        return;
      }
      animationFrame = window.requestAnimationFrame(animate);
    };
    const animate = (time: number): void => {
      animationFrame = 0;
      if (time - lastFrame >= 32) draw(time);
      scheduleAnimation();
    };
    const resizeObserver = new ResizeObserver(() => draw());
    resizeObserver.observe(body);
    const intersectionObserver = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
      if (visible) {
        draw();
        scheduleAnimation();
      } else if (animationFrame !== 0) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
    });
    intersectionObserver.observe(body);
    const handleVisibility = (): void => {
      if (document.hidden) {
        if (animationFrame !== 0) {
          window.cancelAnimationFrame(animationFrame);
          animationFrame = 0;
        }
      } else {
        draw();
        scheduleAnimation();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    draw();
    scheduleAnimation();

    const nearestNode = (
      event: PointerEvent | MouseEvent
    ): GalaxyCanvasPoint | null => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      let nearest: GalaxyCanvasPoint | null = null;
      let nearestDistance = Number.POSITIVE_INFINITY;
      points
        .slice()
        .sort((left, right) => left.depth - right.depth)
        .forEach((point) => {
          const distance = Math.hypot(point.x - x, point.y - y);
          if (
            distance <= Math.max(10, point.radius + 5) &&
            distance < nearestDistance
          ) {
            nearest = point;
            nearestDistance = distance;
          }
        });
      return nearest;
    };
    let pointerId: number | null = null;
    let pointerX = 0;
    let pointerY = 0;
    let dragDistance = 0;
    const handlePointerDown = (event: PointerEvent): void => {
      pointerId = event.pointerId;
      pointerX = event.clientX;
      pointerY = event.clientY;
      dragDistance = 0;
      canvas.setPointerCapture(event.pointerId);
      canvas.addClass("is-dragging");
    };
    const handlePointerMove = (event: PointerEvent): void => {
      if (pointerId === event.pointerId) {
        const deltaX = event.clientX - pointerX;
        const deltaY = event.clientY - pointerY;
        pointerX = event.clientX;
        pointerY = event.clientY;
        dragDistance += Math.abs(deltaX) + Math.abs(deltaY);
        camera.yaw += deltaX * 0.008;
        camera.pitch = Math.max(
          -Math.PI * 0.42,
          Math.min(Math.PI * 0.42, camera.pitch + deltaY * 0.008)
        );
        draw();
        tooltip.hide();
        return;
      }
      const point = nearestNode(event);
      canvas.toggleClass("is-node-hovered", point !== null);
      if (!point) {
        tooltip.hide();
        return;
      }
      tooltip.setText(`${point.node.file.basename} · ${point.node.degree} 个连接`);
      tooltip.setCssProps({
        "--aurora-tooltip-left": `${Math.min(body.clientWidth - 170, point.x + 10)}px`,
        "--aurora-tooltip-top": `${Math.max(42, point.y - 22)}px`
      });
      tooltip.show();
    };
    const finishPointer = (event: PointerEvent): void => {
      if (pointerId !== event.pointerId) return;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      pointerId = null;
      canvas.removeClass("is-dragging");
    };
    const handlePointerLeave = (): void => {
      canvas.removeClass("is-node-hovered");
      tooltip.hide();
    };
    const handleClick = (event: MouseEvent): void => {
      if (dragDistance > 5) {
        dragDistance = 0;
        return;
      }
      const point = nearestNode(event);
      if (point) void this.app.workspace.getLeaf(false).openFile(point.node.file);
    };
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      camera.zoom = Math.max(
        0.72,
        Math.min(2.5, camera.zoom * Math.exp(-event.deltaY * 0.0012))
      );
      draw();
    };
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", finishPointer);
    canvas.addEventListener("pointercancel", finishPointer);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    canvas.addEventListener("click", handleClick);
    canvas.addEventListener("wheel", handleWheel, { passive: false });

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      document.removeEventListener("visibilitychange", handleVisibility);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", finishPointer);
      canvas.removeEventListener("pointercancel", finishPointer);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      canvas.removeEventListener("click", handleClick);
      canvas.removeEventListener("wheel", handleWheel);
      body.remove();
    };
    this.galaxyGraphResource = { key: graphKey, body, dispose };
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
          text: "按源笔记创建日期估算"
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
        ? "历史按源笔记创建日期估算"
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

  private disposeGalaxyGraph(): void {
    this.galaxyGraphResource?.dispose();
    this.galaxyGraphResource = null;
  }
}

interface GalaxyGraphResource {
  key: string;
  body: HTMLElement;
  dispose: () => void;
}

interface GalaxyNode {
  id: string;
  file: TFile;
  degree: number;
  color: string;
  x?: number;
  y?: number;
  z?: number;
}

interface GalaxyLink {
  source: string;
  target: string;
}

interface ResolvedGalaxyLink {
  source: GalaxyNode;
  target: GalaxyNode;
  phase: number;
}

interface GalaxyStar {
  x: number;
  y: number;
  z: number;
  size: number;
  alpha: number;
  color: string;
}

interface GalaxyScene {
  nodes: GalaxyNode[];
  links: ResolvedGalaxyLink[];
  stars: GalaxyStar[];
}

interface GalaxyCamera {
  yaw: number;
  pitch: number;
  zoom: number;
}

interface GalaxyCanvasPoint {
  node: GalaxyNode;
  x: number;
  y: number;
  radius: number;
  depth: number;
}

interface ChartPoint {
  x: number;
  y: number;
}

interface ChartGeometry {
  points: ChartPoint[];
}

function knowledgeGraphKey(snapshot: KnowledgeGraphSnapshot): string {
  let hash = 2166136261;
  const add = (value: string): void => {
    for (const character of value) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
  };
  snapshot.nodes.forEach((node) => add(`${node.file.path}:${node.degree}|`));
  snapshot.edges.forEach((edge) => add(`${edge.source}>${edge.target}|`));
  return `${snapshot.nodes.length}:${snapshot.edges.length}:${hash >>> 0}`;
}

function createGalaxyScene(
  nodes: GalaxyNode[],
  links: GalaxyLink[]
): GalaxyScene {
  const maxDegree = Math.max(1, ...nodes.map((node) => node.degree));
  nodes.forEach((node) => {
    const random = seededRandom(stableHash(node.id));
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    const degreeWeight = Math.sqrt(node.degree / maxDegree);
    const radius = 34 + (1 - degreeWeight) * 145 + random() * 34;
    node.x = radius * Math.sin(phi) * Math.cos(theta);
    node.y = radius * Math.cos(phi) * 0.86;
    node.z = radius * Math.sin(phi) * Math.sin(theta);
  });

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const resolvedLinks = links.flatMap((link, index): ResolvedGalaxyLink[] => {
    const source = nodeById.get(link.source);
    const target = nodeById.get(link.target);
    if (!source || !target) return [];
    return [{ source, target, phase: (index * 0.61803398875) % 1 }];
  });

  relaxGalaxyLayout(nodes, resolvedLinks);
  const random = seededRandom(0x51f15e);
  const starColors = ["#f8f5ff", "#ff63a7", "#a884ff", "#66d9ff"];
  const stars = Array.from({ length: 190 }, (): GalaxyStar => {
    const radius = 235 + random() * 330;
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    return {
      x: radius * Math.sin(phi) * Math.cos(theta),
      y: radius * Math.cos(phi),
      z: radius * Math.sin(phi) * Math.sin(theta),
      size: 0.45 + random() * 1.15,
      alpha: 0.18 + random() * 0.5,
      color: starColors[Math.floor(random() * starColors.length)]!
    };
  });
  return { nodes, links: resolvedLinks, stars };
}

function relaxGalaxyLayout(
  nodes: GalaxyNode[],
  links: ResolvedGalaxyLink[]
): void {
  const forceX = new Float32Array(nodes.length);
  const forceY = new Float32Array(nodes.length);
  const forceZ = new Float32Array(nodes.length);
  const nodeIndex = new Map(nodes.map((node, index) => [node, index]));
  for (let iteration = 0; iteration < 36; iteration += 1) {
    forceX.fill(0);
    forceY.fill(0);
    forceZ.fill(0);
    for (let left = 0; left < nodes.length; left += 1) {
      const a = nodes[left]!;
      const ax = a.x ?? 0;
      const ay = a.y ?? 0;
      const az = a.z ?? 0;
      forceX[left] = (forceX[left] ?? 0) - ax * 0.0018;
      forceY[left] = (forceY[left] ?? 0) - ay * 0.0018;
      forceZ[left] = (forceZ[left] ?? 0) - az * 0.0018;
      for (let right = left + 1; right < nodes.length; right += 1) {
        const b = nodes[right]!;
        const dx = ax - (b.x ?? 0);
        const dy = ay - (b.y ?? 0);
        const dz = az - (b.z ?? 0);
        const distanceSquared = dx * dx + dy * dy + dz * dz + 36;
        const strength = 68 / distanceSquared;
        forceX[left] = (forceX[left] ?? 0) + dx * strength;
        forceY[left] = (forceY[left] ?? 0) + dy * strength;
        forceZ[left] = (forceZ[left] ?? 0) + dz * strength;
        forceX[right] = (forceX[right] ?? 0) - dx * strength;
        forceY[right] = (forceY[right] ?? 0) - dy * strength;
        forceZ[right] = (forceZ[right] ?? 0) - dz * strength;
      }
    }
    links.forEach((link) => {
      const sourceIndex = nodeIndex.get(link.source);
      const targetIndex = nodeIndex.get(link.target);
      if (sourceIndex === undefined || targetIndex === undefined) return;
      const dx = (link.target.x ?? 0) - (link.source.x ?? 0);
      const dy = (link.target.y ?? 0) - (link.source.y ?? 0);
      const dz = (link.target.z ?? 0) - (link.source.z ?? 0);
      const distance = Math.max(1, Math.hypot(dx, dy, dz));
      const spring = (distance - 48) * 0.0065;
      const fx = (dx / distance) * spring;
      const fy = (dy / distance) * spring;
      const fz = (dz / distance) * spring;
      forceX[sourceIndex] = (forceX[sourceIndex] ?? 0) + fx;
      forceY[sourceIndex] = (forceY[sourceIndex] ?? 0) + fy;
      forceZ[sourceIndex] = (forceZ[sourceIndex] ?? 0) + fz;
      forceX[targetIndex] = (forceX[targetIndex] ?? 0) - fx;
      forceY[targetIndex] = (forceY[targetIndex] ?? 0) - fy;
      forceZ[targetIndex] = (forceZ[targetIndex] ?? 0) - fz;
    });
    const step = 0.82 - iteration * 0.012;
    nodes.forEach((node, index) => {
      node.x = (node.x ?? 0) + forceX[index]! * step;
      node.y = (node.y ?? 0) + forceY[index]! * step;
      node.z = (node.z ?? 0) + forceZ[index]! * step;
    });
  }

  const positionedNodes = nodes.filter((node) => node.degree > 0);
  const layoutNodes = positionedNodes.length > 0 ? positionedNodes : nodes;
  if (layoutNodes.length === 0) return;
  const center = layoutNodes.reduce(
    (sum, node) => ({
      x: sum.x + (node.x ?? 0),
      y: sum.y + (node.y ?? 0),
      z: sum.z + (node.z ?? 0)
    }),
    { x: 0, y: 0, z: 0 }
  );
  center.x /= layoutNodes.length;
  center.y /= layoutNodes.length;
  center.z /= layoutNodes.length;
  nodes.forEach((node) => {
    node.x = (node.x ?? 0) - center.x;
    node.y = (node.y ?? 0) - center.y;
    node.z = (node.z ?? 0) - center.z;
  });
  const radii = layoutNodes
    .map((node) => Math.hypot(node.x ?? 0, node.y ?? 0, node.z ?? 0))
    .sort((left, right) => left - right);
  const percentileRadius =
    radii[Math.min(radii.length - 1, Math.floor(radii.length * 0.94))] ?? 1;
  const scale = 150 / Math.max(1, percentileRadius);
  nodes.forEach((node) => {
    let x = (node.x ?? 0) * scale;
    let y = (node.y ?? 0) * scale;
    let z = (node.z ?? 0) * scale;
    const radius = Math.hypot(x, y, z);
    if (radius > 205) {
      const clamp = 205 / radius;
      x *= clamp;
      y *= clamp;
      z *= clamp;
    }
    node.x = x;
    node.y = y;
    node.z = z;
  });
}

function drawGalaxyCanvas(
  canvas: HTMLCanvasElement,
  scene: GalaxyScene,
  camera: GalaxyCamera,
  time: number
): GalaxyCanvasPoint[] {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(300, rect.width);
  const height = Math.max(340, rect.height);
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  if (!context) return [];
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const background = context.createRadialGradient(
    width * 0.48,
    height * 0.46,
    0,
    width * 0.5,
    height * 0.5,
    Math.max(width, height) * 0.72
  );
  background.addColorStop(0, "#10112d");
  background.addColorStop(0.48, "#08091a");
  background.addColorStop(1, "#03040d");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  const yaw = camera.yaw + time * 0.035;
  const project = (x: number, y: number, z: number): ProjectedPoint => {
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const cosPitch = Math.cos(camera.pitch);
    const sinPitch = Math.sin(camera.pitch);
    const rotatedX = x * cosYaw + z * sinYaw;
    const yawZ = -x * sinYaw + z * cosYaw;
    const rotatedY = y * cosPitch - yawZ * sinPitch;
    const rotatedZ = y * sinPitch + yawZ * cosPitch;
    const perspective = 430 / Math.max(150, 430 + rotatedZ);
    const scale = (Math.min(width, height) / 410) * camera.zoom * perspective;
    return {
      x: width / 2 + rotatedX * scale,
      y: height / 2 + rotatedY * scale,
      depth: rotatedZ,
      scale
    };
  };

  scene.stars.forEach((star) => {
    const point = project(star.x, star.y, star.z);
    if (point.x < 0 || point.x > width || point.y < 0 || point.y > height) return;
    context.globalAlpha = star.alpha * Math.max(0.35, point.scale);
    context.fillStyle = star.color;
    context.beginPath();
    context.arc(point.x, point.y, star.size * Math.max(0.5, point.scale), 0, Math.PI * 2);
    context.fill();
  });
  context.globalAlpha = 1;

  const points = scene.nodes.map((node): GalaxyCanvasPoint => {
    const projected = project(node.x ?? 0, node.y ?? 0, node.z ?? 0);
    return {
      node,
      x: projected.x,
      y: projected.y,
      radius:
        (1.65 + Math.min(4.6, Math.log2(node.degree + 2))) *
        Math.max(0.58, projected.scale),
      depth: projected.depth
    };
  });
  const pointById = new Map(points.map((point) => [point.node.id, point]));

  scene.links.forEach((link) => {
    const source = pointById.get(link.source.id);
    const target = pointById.get(link.target.id);
    if (!source || !target) return;
    const depthFactor = Math.max(
      0.28,
      Math.min(1, 0.72 - (source.depth + target.depth) / 900)
    );
    context.strokeStyle = `rgba(174, 151, 255, ${0.2 + depthFactor * 0.34})`;
    context.lineWidth = 0.55 + depthFactor * 0.7;
    context.beginPath();
    context.moveTo(source.x, source.y);
    context.lineTo(target.x, target.y);
    context.stroke();
  });

  const particleStride = Math.max(1, Math.ceil(scene.links.length / 180));
  scene.links.forEach((link, index) => {
    if (index % particleStride !== 0) return;
    const progress = (time * 0.09 + link.phase) % 1;
    const point = project(
      (link.source.x ?? 0) + ((link.target.x ?? 0) - (link.source.x ?? 0)) * progress,
      (link.source.y ?? 0) + ((link.target.y ?? 0) - (link.source.y ?? 0)) * progress,
      (link.source.z ?? 0) + ((link.target.z ?? 0) - (link.source.z ?? 0)) * progress
    );
    context.globalAlpha = 0.72;
    context.fillStyle = "#ff5aa6";
    context.beginPath();
    context.arc(point.x, point.y, Math.max(0.7, point.scale * 1.15), 0, Math.PI * 2);
    context.fill();
  });

  points
    .slice()
    .sort((left, right) => right.depth - left.depth)
    .forEach((point) => {
      context.shadowColor = point.node.color;
      context.shadowBlur = 5 + point.radius;
      context.fillStyle = point.node.color;
      context.globalAlpha = Math.max(0.52, Math.min(0.96, 0.78 - point.depth / 900));
      context.beginPath();
      context.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
      context.fill();
    });
  context.shadowBlur = 0;
  context.globalAlpha = 1;
  return points;
}

interface ProjectedPoint {
  x: number;
  y: number;
  depth: number;
  scale: number;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
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
