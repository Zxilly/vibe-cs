import { describe, expect, it } from "vitest";

import { literalEnUS, literalZhCN } from "./literals";

describe("current product copy", () => {
  it("describes presets, cache, and snapshots without internal generation language", () => {
    expect({
      presetCreated: literalZhCN.m0498,
      replayCache: literalZhCN.m0743,
      replayCacheFields: literalZhCN.m0380,
      presetGroup: literalZhCN.m0970,
      snapshot: literalZhCN.m0971,
    }).toEqual({
      presetCreated: "片段预设已创建。",
      replayCache: "服务会优先校验当前本地缓存，未命中时再从已保存分析生成。",
      replayCacheFields: "当前回放缓存字段无效",
      presetGroup: "片段预设",
      snapshot: "工程快照",
    });

    expect({
      presetCreated: literalEnUS.m0498,
      replayCache: literalEnUS.m0743,
      replayCacheFields: literalEnUS.m0380,
      presetGroup: literalEnUS.m0970,
      snapshot: literalEnUS.m0971,
    }).toEqual({
      presetCreated: "Clip preset created.",
      replayCache:
        "The service checks the current local cache first, then generates it from the saved analysis on a miss.",
      replayCacheFields: "Current replay cache fields are invalid",
      presetGroup: "Clip presets",
      snapshot: "Project snapshot",
    });
  });
});
