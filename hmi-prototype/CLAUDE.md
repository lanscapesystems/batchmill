# HMI Design Rules

## Typography

| Role | Size | Weight | Color |
|------|------|--------|-------|
| Page header | 16px | 700 | `--fg-bright` |
| Panel title | 12px | 600 | `--fg-bright`, uppercase, letter-spacing 0.03em |
| Body / table cells | 12–13px | 400 | `--fg` |
| Primary values | 12–13px | 500–600 | `--fg-bright` |
| Labels / captions | 11px | 400 | `--fg-dim` |

**Minimum text size: 11px.** Nothing smaller, anywhere. This includes badges, hints, and annotations.

## Color Tokens

All colors come from CSS custom properties in `globals.css`. Never hard-code hex in components.

- `--fg-bright` (#eee) — primary values, selected items, headings
- `--fg` (#ccc) — body text
- `--fg-dim` (#aaa) — labels, secondary text, inactive states
- `--accent` (#4caf50) — active tab indicator, primary action buttons
- `--green` / `--red` / `--orange` — status: running/fault/warning
- `--bg` (#111) / `--bg-panel` (#1a1a1a) / `--bg-row` (#222) — layer backgrounds
- `--border` (#2a2a2a) — all borders

Contrast: `--fg-dim` on `--bg-panel` = 7.7:1 (AAA). Do not introduce colors below WCAG AA (4.5:1).

## Buttons

- **Primary**: `background: var(--accent)`, `color: #000`, weight 600
- **Destructive**: `background: var(--red)`, `color: #fff`
- **Ghost/secondary**: `background: transparent`, `border: 1px solid var(--border)`, `color: var(--fg-dim)`
- Standard padding: `6px 14px`. Compact: `4px 10px`.
- Always: 12px, weight 600, border-radius 3px, `cursor: pointer`.

## Panels

- `background: var(--bg-panel)`, `border: 1px solid var(--border)`, `border-radius: 3px`
- Title bar: 12px uppercase, weight 600, letter-spacing 0.03em, `border-bottom: 1px solid var(--border)`

## Tables

- Header: `color: var(--fg-dim)`, weight 600, `border-bottom: 1px solid var(--border)`
- Cell padding: `py-2 px-3`
- Row separator: `border-bottom: 1px solid var(--border)`
- Numeric columns: right-aligned, primary values in `--fg-bright`

## Status Indicators

- Dot: 8–10px circle (`w-2 h-2` or `w-2.5 h-2.5`)
- Active: saturated color (`--green`, `--red`, `--orange`)
- Inactive/cleared: `var(--fg-dim)` or `var(--gray)`
- Text label matches dot color

## Modals

- Overlay: `rgba(0,0,0,0.5)`, centered flex, z-index 1000
- Card: `var(--bg-panel)`, `border: 1px solid var(--border)`, border-radius 6px, padding `16px 20px`
- Title: 13px, weight 600, `--fg-bright`
- Body: 12px
- Actions: right-aligned, `gap-2`

## Inputs / Selects

- `background: var(--bg)`, `border: 1px solid var(--border)`, border-radius 3px
- `color: var(--fg-bright)`, padding `4px 8px`, 12px
- Checkbox accent: `var(--accent)`
