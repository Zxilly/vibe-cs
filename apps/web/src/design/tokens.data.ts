/**
 * Approved visual contract for both Vibe CS work modes (2026-09-06).
 * Figma variables/styles are the design authority; theme.css is their CSS projection.
 * Numeric timeline geometry is intentionally outside this visual contract.
 */
export const DESIGN_SYSTEM = {
  fileKey: 'N05FPVtPTwWV3ONlE48Fwv',
  foundationsNode: '493:3223',
  editingNode: '532:3157',
  analysisNode: '533:5737',
  approvedOn: '2026-09-06',
  bodyFont: 'Noto Sans SC',
  monoFont: 'Roboto Mono',
} as const;

/** Exact semantic bindings read back from Figma, including shared aliases. */
export const FIGMA_BINDINGS = [
  {
    "name": "color/bg/base",
    "css": "var(--color-bg)",
    "light": "#ffffff",
    "dark": "#111827"
  },
  {
    "name": "color/bg/surface",
    "css": "var(--color-surface)",
    "light": "#f1f3f6",
    "dark": "#182234"
  },
  {
    "name": "color/bg/chrome",
    "css": "var(--color-surface-chrome)",
    "light": "#f6f7f9",
    "dark": "#141e30"
  },
  {
    "name": "color/text/primary",
    "css": "var(--color-text)",
    "light": "#1d1f20",
    "dark": "#e6edf7"
  },
  {
    "name": "color/text/muted",
    "css": "var(--color-neutral-600)",
    "light": "#606c7e",
    "dark": "#b3c1d1"
  },
  {
    "name": "color/text/strong",
    "css": "var(--color-neutral-700)",
    "light": "#465265",
    "dark": "#c6d2e2"
  },
  {
    "name": "color/text/subtle",
    "css": "var(--color-neutral-500)",
    "light": "#606c7e",
    "dark": "#a5b4c7"
  },
  {
    "name": "color/accent/default",
    "css": "var(--color-accent)",
    "light": "#3268d6",
    "dark": "#8db3f4"
  },
  {
    "name": "color/accent/hover",
    "css": "var(--color-accent-600)",
    "light": "#285abd",
    "dark": "#a3c3fa"
  },
  {
    "name": "color/accent/pressed",
    "css": "var(--color-accent-700)",
    "light": "#214b98",
    "dark": "#b8d0fa"
  },
  {
    "name": "color/bg/selected",
    "css": "var(--color-accent-100)",
    "light": "#eef4ff",
    "dark": "#243953"
  },
  {
    "name": "color/border/default",
    "css": "var(--color-divider)",
    "light": "#dfe3e9",
    "dark": "#2f4058"
  },
  {
    "name": "color/border/strong",
    "css": "var(--color-neutral-300)",
    "light": "#d8dee8",
    "dark": "#3b4d66"
  },
  {
    "name": "color/bg/neutral",
    "css": "var(--color-neutral-200)",
    "light": "#edf0f4",
    "dark": "#243449"
  },
  {
    "name": "color/status/ok",
    "css": "var(--color-ok)",
    "light": "#4d7a5a",
    "dark": "#82be92"
  },
  {
    "name": "color/status/warn",
    "css": "var(--color-warn)",
    "light": "#a8792f",
    "dark": "#e3b878"
  },
  {
    "name": "color/status/fail",
    "css": "var(--color-fail)",
    "light": "#a3453c",
    "dark": "#ec9990"
  },
  {
    "name": "color/bg/ok",
    "css": "var(--color-ok-surface)",
    "light": "#eef4ee",
    "dark": "#20382d"
  },
  {
    "name": "color/bg/warn",
    "css": "var(--color-warn-surface)",
    "light": "#f7efdd",
    "dark": "#352c1e"
  },
  {
    "name": "color/bg/fail",
    "css": "var(--color-fail-surface)",
    "light": "#f7ecea",
    "dark": "#3a2528"
  },
  {
    "name": "spacing/base",
    "css": "var(--spacing)",
    "light": 4,
    "dark": 4
  },
  {
    "name": "spacing/2",
    "css": "calc(var(--spacing) * 2)",
    "light": 8,
    "dark": 8
  },
  {
    "name": "spacing/3",
    "css": "calc(var(--spacing) * 3)",
    "light": 12,
    "dark": 12
  },
  {
    "name": "spacing/4",
    "css": "calc(var(--spacing) * 4)",
    "light": 16,
    "dark": 16
  },
  {
    "name": "spacing/6",
    "css": "calc(var(--spacing) * 6)",
    "light": 24,
    "dark": 24
  },
  {
    "name": "spacing/8",
    "css": "calc(var(--spacing) * 8)",
    "light": 32,
    "dark": 32
  },
  {
    "name": "control/sm",
    "css": "var(--h-ctl-sm)",
    "light": 32,
    "dark": 32
  },
  {
    "name": "control/md",
    "css": "var(--h-ctl-md)",
    "light": 36,
    "dark": 36
  },
  {
    "name": "control/lg",
    "css": "var(--h-ctl-lg)",
    "light": 40,
    "dark": 40
  },
  {
    "name": "control/hero",
    "css": "var(--h-ctl-hero)",
    "light": 44,
    "dark": 44
  },
  {
    "name": "radius/sm",
    "css": "var(--radius-sm)",
    "light": 4,
    "dark": 4
  },
  {
    "name": "radius/md",
    "css": "var(--radius-md)",
    "light": 6,
    "dark": 6
  },
  {
    "name": "radius/lg",
    "css": "var(--radius-lg)",
    "light": 8,
    "dark": 8
  },
  {
    "name": "row/default",
    "css": "var(--h-row)",
    "light": 44,
    "dark": 44
  },
  {
    "name": "row/evidence",
    "css": "var(--h-row-evidence)",
    "light": 56,
    "dark": 56
  },
  {
    "name": "color/state/ink-hover",
    "css": "var(--color-action-hover)",
    "light": "#1d1f2012",
    "dark": "#e6edf712"
  },
  {
    "name": "color/state/ink-pressed",
    "css": "var(--color-action-pressed)",
    "light": "#1d1f2024",
    "dark": "#e6edf724"
  },
  {
    "name": "color/state/ghost-hover",
    "css": "var(--color-action-hover)",
    "light": "#1d1f2012",
    "dark": "#e6edf712"
  },
  {
    "name": "color/state/ghost-pressed",
    "css": "var(--color-action-pressed)",
    "light": "#1d1f2024",
    "dark": "#e6edf724"
  },
  {
    "name": "color/state/danger-hover",
    "css": "var(--color-danger-hover)",
    "light": "#893f37",
    "dark": "#f0ada5"
  },
  {
    "name": "color/state/danger-pressed",
    "css": "var(--color-danger-pressed)",
    "light": "#763a34",
    "dark": "#f4c0b8"
  },
  {
    "name": "color/state/on-accent",
    "css": "var(--color-on-accent)",
    "light": "#ffffff",
    "dark": "#111827"
  },
  {
    "name": "spacing/control",
    "css": "calc(var(--spacing) * 3)",
    "light": 12,
    "dark": 12
  },
  {
    "name": "spacing/control-hero",
    "css": "calc(var(--spacing) * 6)",
    "light": 24,
    "dark": 24
  },
  {
    "name": "color/border/transparent",
    "css": "var(--color-transparent)",
    "light": "#00000000",
    "dark": "#00000000"
  },
  {
    "name": "color/bg/list-hover",
    "css": "var(--color-neutral-100)",
    "light": "#f8fafc",
    "dark": "#1c293d"
  },
  {
    "name": "color/accent/selection-marker",
    "css": "var(--color-accent-500)",
    "light": "#4f84f7",
    "dark": "#8db3f4"
  },
  {
    "name": "color/status/stale",
    "css": "var(--color-fail-text)",
    "light": "#723933",
    "dark": "#ec9990"
  },
  {
    "name": "spacing/1-5",
    "css": "calc(var(--spacing) * 1.5)",
    "light": 6,
    "dark": 6
  },
  {
    "name": "color/text/warn",
    "css": "var(--color-warn-text)",
    "light": "#74582f",
    "dark": "#e3b878"
  },
  {
    "name": "color/border/warn",
    "css": "var(--color-warn-border)",
    "light": "#d8bb86",
    "dark": "#6c5537"
  },
  {
    "name": "color/icon/subtle",
    "css": "var(--color-neutral-400)",
    "light": "#aab3c1",
    "dark": "#8191a6"
  },
  {
    "name": "spacing/2-5",
    "css": "calc(var(--spacing) * 2.5)",
    "light": 10,
    "dark": 10
  },
  {
    "name": "color/border/recorded-clip",
    "css": "var(--color-accent-300)",
    "light": "#b9d1ff",
    "dark": "#3c608a"
  },
  {
    "name": "color/text/timeline-label",
    "css": "var(--color-neutral-800)",
    "light": "#303b4d",
    "dark": "#d8e2ef"
  },
  {
    "name": "color/bg/media-badge",
    "css": "var(--color-media-badge)",
    "light": "#1b2637",
    "dark": "#111827"
  },
  {
    "name": "color/border/media-badge",
    "css": "var(--color-media-badge-border)",
    "light": "#465265",
    "dark": "#3b4d66"
  },
  {
    "name": "panel/header",
    "css": "var(--h-panel-head)",
    "light": 36,
    "dark": 36
  },
  {
    "name": "window/header",
    "css": "var(--h-titlebar)",
    "light": 48,
    "dark": 48
  },
  {
    "name": "page/toolbar",
    "css": "var(--h-topbar)",
    "light": 56,
    "dark": 56
  },
  {
    "name": "panel/command",
    "css": "var(--h-bar)",
    "light": 44,
    "dark": 44
  },
  {
    "name": "table/header",
    "css": "var(--h-thead)",
    "light": 36,
    "dark": 36
  },
  {
    "name": "row/compact",
    "css": "var(--h-row-compact)",
    "light": 36,
    "dark": 36
  },
  {
    "name": "panel/inset",
    "css": "var(--panel-inset)",
    "light": 12,
    "dark": 12
  },
  {
    "name": "panel/gap",
    "css": "var(--panel-gap)",
    "light": 8,
    "dark": 8
  },
  {
    "name": "scrollbar/width",
    "css": "var(--scrollbar-size)",
    "light": 10,
    "dark": 10
  },
  {
    "name": "color/bg/media",
    "css": "var(--color-media)",
    "light": "#111827",
    "dark": "#111827"
  },
  {
    "name": "color/text/on-media",
    "css": "var(--color-on-media)",
    "light": "#f8fafc",
    "dark": "#f8fafc"
  },
  {
    "name": "color/text/on-media-muted",
    "css": "var(--color-on-media-muted)",
    "light": "#a5b4c7",
    "dark": "#a5b4c7"
  },
  {
    "name": "color/border/media",
    "css": "var(--color-media-divider)",
    "light": "#3b4d66",
    "dark": "#3b4d66"
  }
] as const;

/** Closed CSS token set: semantic bindings plus tonal ramps and layout roles. */
export const LIGHT_TOKENS: Readonly<Record<string, string>> = {
  "--color-transparent": "transparent",
  "--color-current": "currentColor",
  "--color-bg": "#ffffff",
  "--color-surface": "#f1f3f6",
  "--color-surface-chrome": "#f6f7f9",
  "--color-text": "#1d1f20",
  "--color-neutral-600": "#606c7e",
  "--color-neutral-700": "#465265",
  "--color-neutral-500": "#606c7e",
  "--color-accent": "#3268d6",
  "--color-accent-600": "#285abd",
  "--color-accent-700": "#214b98",
  "--color-accent-100": "#eef4ff",
  "--color-divider": "#dfe3e9",
  "--color-neutral-300": "#d8dee8",
  "--color-neutral-200": "#edf0f4",
  "--color-ok": "#4d7a5a",
  "--color-warn": "#a8792f",
  "--color-fail": "#a3453c",
  "--color-ok-surface": "#eef4ee",
  "--color-warn-surface": "#f7efdd",
  "--color-fail-surface": "#f7ecea",
  "--color-action-hover": "#1d1f2012",
  "--color-action-pressed": "#1d1f2024",
  "--color-danger-hover": "#893f37",
  "--color-danger-pressed": "#763a34",
  "--color-on-accent": "#ffffff",
  "--color-neutral-100": "#f8fafc",
  "--color-accent-500": "#4f84f7",
  "--color-fail-text": "#723933",
  "--color-warn-text": "#74582f",
  "--color-warn-border": "#d8bb86",
  "--color-neutral-400": "#aab3c1",
  "--color-accent-300": "#b9d1ff",
  "--color-neutral-800": "#303b4d",
  "--color-media-badge": "#1b2637",
  "--color-media-badge-border": "#465265",
  "--color-media": "#111827",
  "--color-on-media": "#f8fafc",
  "--color-on-media-muted": "#a5b4c7",
  "--color-media-divider": "#3b4d66",
  "--color-neutral-50": "#ffffff",
  "--color-neutral-950": "#111827",
  "--color-neutral-900": "#1b2637",
  "--color-accent-2": "#5b8ff9",
  "--color-accent-200": "#d9e7ff",
  "--color-accent-400": "#79a4f0",
  "--color-accent-800": "#214b98",
  "--color-accent-900": "#1d2d3d",
  "--color-accent-2-100": "#eef4ff",
  "--color-accent-2-200": "#d9e7ff",
  "--color-accent-2-300": "#b9d1ff",
  "--color-accent-2-400": "#79a4f0",
  "--color-accent-2-500": "#5b8ff9",
  "--color-accent-2-600": "#285abd",
  "--color-accent-2-700": "#214b98",
  "--color-accent-2-800": "#214b98",
  "--color-accent-2-900": "#1d2d3d",
  "--color-ok-text": "#3c5a44",
  "--color-ok-border": "#a8c3a9",
  "--color-fail-border": "#c9a8a3",
  "--color-team-b": "#c9a55a",
  "--color-grid": "color-mix(in oklab, var(--color-text) 5%, var(--color-bg))",
  "--shadow-sm": "0 1px 2px #2b2b2d24",
  "--shadow-md": "0 3px 10px #2b2b2d29",
  "--shadow-lg": "0 12px 32px #2b2b2d38",
  "--font-body": "'Noto Sans SC Variable', 'Noto Sans SC', sans-serif",
  "--font-heading": "'Noto Sans SC Variable', 'Noto Sans SC', sans-serif",
  "--font-heading-weight": "700",
  "--font-mono": "'Roboto Mono Variable', 'Roboto Mono', monospace",
  "--text-xs": "12px",
  "--text-xs--line-height": "18px",
  "--text-sm": "13px",
  "--text-sm--line-height": "20px",
  "--text-base": "14px",
  "--text-base--line-height": "22px",
  "--text-md": "16px",
  "--text-md--line-height": "26px",
  "--text-lg": "18px",
  "--text-lg--line-height": "26px",
  "--text-xl": "20px",
  "--text-xl--line-height": "28px",
  "--text-2xl": "24px",
  "--text-2xl--line-height": "32px",
  "--text-3xl": "28px",
  "--text-3xl--line-height": "36px",
  "--text-4xl": "32px",
  "--text-4xl--line-height": "40px",
  "--leading-tight": "1.3",
  "--leading-normal": "1.5714285714",
  "--leading-relaxed": "1.75",
  "--tracking-caps": "0.08em",
  "--tracking-wide": "0.04em",
  "--spacing": "4px",
  "--radius-sm": "4px",
  "--radius-md": "6px",
  "--radius-lg": "8px",
  "--radius-full": "999px",
  "--h-ctl-sm": "32px",
  "--h-ctl-md": "36px",
  "--h-ctl-lg": "40px",
  "--h-ctl-hero": "44px",
  "--h-titlebar": "48px",
  "--h-topbar": "56px",
  "--h-bar": "44px",
  "--h-panel-head": "36px",
  "--h-thead": "36px",
  "--h-row": "44px",
  "--h-row-compact": "36px",
  "--h-row-evidence": "56px",
  "--h-row-task": "64px",
  "--h-composer": "80px",
  "--h-actionbar": "92px",
  "--w-nav": "216px",
  "--w-nav-collapsed": "56px",
  "--w-agent-rail": "46px",
  "--w-subnav": "190px",
  "--w-panel": "340px",
  "--w-inspector": "380px",
  "--w-inspector-wide": "440px",
  "--w-split": "520px",
  "--w-track-head": "190px",
  "--w-overlay": "600px",
  "--w-output-preview": "144px",
  "--panel-inset": "12px",
  "--panel-gap": "8px",
  "--scrollbar-size": "10px",
  "--h-nav-item": "40px"
};

export const COLOR_TOKENS: Readonly<Record<string, { readonly light: string; readonly dark: string }>> = {
  "--color-bg": {
    "light": "#ffffff",
    "dark": "#111827"
  },
  "--color-surface": {
    "light": "#f1f3f6",
    "dark": "#182234"
  },
  "--color-surface-chrome": {
    "light": "#f6f7f9",
    "dark": "#141e30"
  },
  "--color-text": {
    "light": "#1d1f20",
    "dark": "#e6edf7"
  },
  "--color-neutral-600": {
    "light": "#606c7e",
    "dark": "#b3c1d1"
  },
  "--color-neutral-700": {
    "light": "#465265",
    "dark": "#c6d2e2"
  },
  "--color-neutral-500": {
    "light": "#606c7e",
    "dark": "#a5b4c7"
  },
  "--color-accent": {
    "light": "#3268d6",
    "dark": "#8db3f4"
  },
  "--color-accent-600": {
    "light": "#285abd",
    "dark": "#a3c3fa"
  },
  "--color-accent-700": {
    "light": "#214b98",
    "dark": "#b8d0fa"
  },
  "--color-accent-100": {
    "light": "#eef4ff",
    "dark": "#243953"
  },
  "--color-divider": {
    "light": "#dfe3e9",
    "dark": "#2f4058"
  },
  "--color-neutral-300": {
    "light": "#d8dee8",
    "dark": "#3b4d66"
  },
  "--color-neutral-200": {
    "light": "#edf0f4",
    "dark": "#243449"
  },
  "--color-ok": {
    "light": "#4d7a5a",
    "dark": "#82be92"
  },
  "--color-warn": {
    "light": "#a8792f",
    "dark": "#e3b878"
  },
  "--color-fail": {
    "light": "#a3453c",
    "dark": "#ec9990"
  },
  "--color-ok-surface": {
    "light": "#eef4ee",
    "dark": "#20382d"
  },
  "--color-warn-surface": {
    "light": "#f7efdd",
    "dark": "#352c1e"
  },
  "--color-fail-surface": {
    "light": "#f7ecea",
    "dark": "#3a2528"
  },
  "--color-action-hover": {
    "light": "#1d1f2012",
    "dark": "#e6edf712"
  },
  "--color-action-pressed": {
    "light": "#1d1f2024",
    "dark": "#e6edf724"
  },
  "--color-danger-hover": {
    "light": "#893f37",
    "dark": "#f0ada5"
  },
  "--color-danger-pressed": {
    "light": "#763a34",
    "dark": "#f4c0b8"
  },
  "--color-on-accent": {
    "light": "#ffffff",
    "dark": "#111827"
  },
  "--color-neutral-100": {
    "light": "#f8fafc",
    "dark": "#1c293d"
  },
  "--color-accent-500": {
    "light": "#4f84f7",
    "dark": "#8db3f4"
  },
  "--color-fail-text": {
    "light": "#723933",
    "dark": "#ec9990"
  },
  "--color-warn-text": {
    "light": "#74582f",
    "dark": "#e3b878"
  },
  "--color-warn-border": {
    "light": "#d8bb86",
    "dark": "#6c5537"
  },
  "--color-neutral-400": {
    "light": "#aab3c1",
    "dark": "#8191a6"
  },
  "--color-accent-300": {
    "light": "#b9d1ff",
    "dark": "#3c608a"
  },
  "--color-neutral-800": {
    "light": "#303b4d",
    "dark": "#d8e2ef"
  },
  "--color-media-badge": {
    "light": "#1b2637",
    "dark": "#111827"
  },
  "--color-media-badge-border": {
    "light": "#465265",
    "dark": "#3b4d66"
  },
  "--color-media": {
    "light": "#111827",
    "dark": "#111827"
  },
  "--color-on-media": {
    "light": "#f8fafc",
    "dark": "#f8fafc"
  },
  "--color-on-media-muted": {
    "light": "#a5b4c7",
    "dark": "#a5b4c7"
  },
  "--color-media-divider": {
    "light": "#3b4d66",
    "dark": "#3b4d66"
  },
  "--color-neutral-50": {
    "light": "#ffffff",
    "dark": "#141e30"
  },
  "--color-neutral-950": {
    "light": "#111827",
    "dark": "#e6edf7"
  },
  "--color-neutral-900": {
    "light": "#1b2637",
    "dark": "#e6edf7"
  },
  "--color-accent-2": {
    "light": "#5b8ff9",
    "dark": "#a3c3fa"
  },
  "--color-accent-200": {
    "light": "#d9e7ff",
    "dark": "#304b6c"
  },
  "--color-accent-400": {
    "light": "#79a4f0",
    "dark": "#628ec4"
  },
  "--color-accent-800": {
    "light": "#214b98",
    "dark": "#c4d9fc"
  },
  "--color-accent-900": {
    "light": "#1d2d3d",
    "dark": "#e0ebff"
  },
  "--color-accent-2-100": {
    "light": "#eef4ff",
    "dark": "#243953"
  },
  "--color-accent-2-200": {
    "light": "#d9e7ff",
    "dark": "#304b6c"
  },
  "--color-accent-2-300": {
    "light": "#b9d1ff",
    "dark": "#3c608a"
  },
  "--color-accent-2-400": {
    "light": "#79a4f0",
    "dark": "#628ec4"
  },
  "--color-accent-2-500": {
    "light": "#5b8ff9",
    "dark": "#8db3f4"
  },
  "--color-accent-2-600": {
    "light": "#285abd",
    "dark": "#a3c3fa"
  },
  "--color-accent-2-700": {
    "light": "#214b98",
    "dark": "#b8d0fa"
  },
  "--color-accent-2-800": {
    "light": "#214b98",
    "dark": "#c4d9fc"
  },
  "--color-accent-2-900": {
    "light": "#1d2d3d",
    "dark": "#e0ebff"
  },
  "--color-ok-text": {
    "light": "#3c5a44",
    "dark": "#82be92"
  },
  "--color-ok-border": {
    "light": "#a8c3a9",
    "dark": "#42684f"
  },
  "--color-fail-border": {
    "light": "#c9a8a3",
    "dark": "#744b50"
  },
  "--color-team-b": {
    "light": "#c9a55a",
    "dark": "#e3bd78"
  },
  "--color-grid": {
    "light": "color-mix(in oklab, var(--color-text) 5%, var(--color-bg))",
    "dark": "color-mix(in oklab, var(--color-text) 6%, var(--color-bg))"
  }
};

/** Structural widths consumed by the design-layer boundary checker. */
export const PANEL_WIDTH_PX = {
  '--w-nav': 216,
  '--w-nav-collapsed': 56,
  '--w-agent-rail': 46,
  '--w-subnav': 190,
  '--w-panel': 340,
  '--w-inspector': 380,
  '--w-inspector-wide': 440,
  '--w-split': 520,
  '--w-track-head': 190,
  '--w-overlay': 600,
  '--w-output-preview': 144,
};

export const TYPE_ROLES = {
  "xs": [
    12,
    18
  ],
  "sm": [
    13,
    20
  ],
  "base": [
    14,
    22
  ],
  "md": [
    16,
    26
  ],
  "lg": [
    18,
    26
  ],
  "xl": [
    20,
    28
  ],
  "2xl": [
    24,
    32
  ],
  "3xl": [
    28,
    36
  ],
  "4xl": [
    32,
    40
  ]
} as const;
