import { describe, expect, test } from "bun:test";
import { toYaml } from "../src/util.ts";

describe("YAML 输出", () => {
  test("标量与嵌套结构", () => {
    const yaml = toYaml({
      status: "ok",
      count: 2,
      empty: null,
      spaced: "hello world",
      list: [1, 2],
      nested: { a: true, b: "" },
    });
    expect(yaml).toBe(
      [
        "status: ok",
        "count: 2",
        "empty: null",
        'spaced: "hello world"',
        "list:",
        "  - 1",
        "  - 2",
        "nested:",
        "  a: true",
        '  b: ""',
      ].join("\n"),
    );
  });

  test("对象数组按块缩进", () => {
    const yaml = toYaml({ rows: [{ a: 1 }, { a: 2 }] });
    expect(yaml).toBe(["rows:", "  - a: 1", "  - a: 2"].join("\n"));
  });

  test("中文与特殊字符加引号", () => {
    expect(toYaml({ t: "测试: 内容" })).toBe('t: "测试: 内容"');
  });
});
