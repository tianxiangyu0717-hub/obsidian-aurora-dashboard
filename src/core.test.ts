import { describe, expect, it } from "vitest";
import {
  activityLevel,
  buildCumulativeLinkHistory,
  countWords,
  dayKeysEndingToday,
  extractOpenTasks,
  formatCompactNumber,
  historicalDateKey,
  localDateKey,
  normalizeTodoFilePath,
  updateMarkdownTask
} from "./core";

describe("countWords", () => {
  it("counts Chinese characters and Latin words", () => {
    expect(countWords("# 标题\n\nHello world，这是测试。")).toBe(8);
  });

  it("ignores frontmatter and fenced code", () => {
    const source = [
      "---",
      "title: hidden metadata",
      "---",
      "可见文本",
      "```ts",
      "const hidden = true;",
      "```"
    ].join("\n");
    expect(countWords(source)).toBe(4);
  });

  it("uses visible wikilink aliases", () => {
    expect(countWords("[[Very long target|显示名]]")).toBe(3);
  });
});
describe("extractOpenTasks", () => {
  it("finds only unchecked markdown tasks", () => {
    const tasks = extractOpenTasks("- [ ] First\n- [x] Done\n  * [ ] 第二项");
    expect(tasks).toEqual([
      { line: 0, text: "First", raw: "- [ ] First" },
      { line: 2, text: "第二项", raw: "  * [ ] 第二项" }
    ]);
  });

  it("edits and completes the original task line", () => {
    const source = "Intro\n- [ ] First task\nOutro";
    const task = extractOpenTasks(source)[0];
    expect(task).toBeDefined();
    const edited = updateMarkdownTask(source, task!, { text: "Edited task" });
    const editedTask = extractOpenTasks(edited)[0];
    expect(editedTask).toBeDefined();
    expect(updateMarkdownTask(edited, editedTask!, { completed: true })).toBe(
      "Intro\n- [x] Edited task\nOutro"
    );
  });

  it("refuses to overwrite a task when its source line disappeared", () => {
    const task = extractOpenTasks("- [ ] Original")[0];
    expect(task).toBeDefined();
    expect(() =>
      updateMarkdownTask("- [ ] Replaced", task!, { text: "Edited" })
    ).toThrow("任务所在行已经发生变化");
  });
});

describe("normalizeTodoFilePath", () => {
  it("adds a Markdown extension and normalizes common separators", () => {
    expect(normalizeTodoFilePath("/日记/2026-08-01")).toBe(
      "日记/2026-08-01.md"
    );
    expect(normalizeTodoFilePath("工作\\Todo.md")).toBe("工作/Todo.md");
    expect(normalizeTodoFilePath("  ")).toBe("");
  });
});

describe("date and presentation helpers", () => {
  it("builds inclusive day ranges ending today", () => {
    expect(dayKeysEndingToday(3, new Date(2026, 6, 31))).toEqual([
      "2026-07-29",
      "2026-07-30",
      "2026-07-31"
    ]);
  });

  it("formats local dates", () => {
    expect(localDateKey(new Date(2026, 0, 2))).toBe("2026-01-02");
  });

  it("uses creation time for historical estimates when notes were edited later", () => {
    expect(
      historicalDateKey(
        new Date(2026, 2, 15).getTime(),
        new Date(2026, 7, 12).getTime(),
        new Date(2026, 7, 18).getTime()
      )
    ).toBe("2026-03-15");
  });

  it("falls back to modification time when creation time is unavailable", () => {
    expect(
      historicalDateKey(
        0,
        new Date(2026, 6, 9).getTime(),
        new Date(2026, 7, 18).getTime()
      )
    ).toBe("2026-07-09");
  });

  it("maps values to stable activity levels", () => {
    expect(activityLevel(0, 100)).toBe(0);
    expect(activityLevel(8, 100)).toBe(1);
    expect(activityLevel(50, 100)).toBe(4);
    expect(activityLevel(100, 100)).toBe(5);
  });

  it("formats Chinese compact numbers", () => {
    expect(formatCompactNumber(369_155)).toBe("36.9 万");
    expect(formatCompactNumber(368)).toBe("368");
  });

  it("combines estimated link history with exact daily snapshots", () => {
    expect(
      buildCumulativeLinkHistory(
        ["2026-07-30", "2026-07-31", "2026-08-01"],
        ["2026-07-29", "2026-07-30", "2026-07-31"],
        { "2026-08-01": 5 },
        new Date(2026, 7, 1).getTime()
      )
    ).toEqual([
      { date: "2026-07-30", count: 2, estimated: true },
      { date: "2026-07-31", count: 3, estimated: true },
      { date: "2026-08-01", count: 5, estimated: false }
    ]);
  });
});
