# Changelog

## 0.3.1

- Reuse the existing 3D knowledge-graph renderer while its topology is unchanged, preventing repeated Dashboard scans from exhausting WebGL contexts.
- Dispose Dashboard graph resources safely without forcing context loss that could disturb Obsidian's built-in graph renderer.
- Fall back to an interactive 2D canvas graph with clickable notes and a retry control when WebGL is unavailable.

## 0.3.0

- Add a fourth focus module for the cumulative resolved-link count over the latest 365 days.
- Render the link history as an interactive line-area chart with date, count, and estimate provenance on hover.
- Store exact daily link-count snapshots locally from the first scan onward and transparently estimate earlier history from source-note modification dates.
- Show Todo, Knowledge Graph, Writing Activity, and Link Count in one four-column row on wide panes and a responsive two-by-two grid on narrow panes.

## 0.2.1

- Place Todo, Knowledge Graph, and Writing Activity in one responsive, edge-aligned three-card row.
- Center the Todo empty state within the complete card body.
- Increase the knowledge graph's initial apparent scale and preserve clearer visible connections.
- Combine the past 12 months into one axis-free daily activity matrix.
- Expand the activity matrix to fill its card and add subtle light-gray borders to every day cell.

## 0.2.0

- Rename the displayed plugin to Dashboard and add a horizontally scrollable, manually ordered plugin shortcut strip.
- Add an editable Todo card that reads only one explicitly configured Markdown file and remains empty by default.
- Add an interactive animated 3D galaxy knowledge graph with clearer links, moving particles, note tooltips, and clickable nodes.
- Keep the Todo and knowledge graph cards equally sized, with a square graph viewport and a closer initial camera position.
- Redesign the writing activity calendar as a full-width row with seamless rose-colored cells and a compact dark-to-light legend.
- Update the project preview image to show the new Dashboard layout and 3D knowledge graph.

## 0.1.2

- Add searchable declarative settings for Obsidian 1.13 while preserving the legacy settings view for older supported versions.
- Remove a deprecated slider tooltip API and avoid a false-positive CSS compatibility warning.
- Generate release notes and publish GitHub build-provenance attestations for release assets.

## 0.1.1

- Preserve open dashboard leaves when the plugin unloads so Obsidian can restore them after updates.
- Move dynamic chart and folder-bar geometry into scoped CSS custom properties for theme-friendly styling.

## 0.1.0

- Add a startup home dashboard with vault-wide note, word, backlink, and short-note metrics.
- Add clickable detail views for every headline metric and maintenance issue.
- Add a 12-month writing activity heatmap and 30-day word trend.
- Track exact positive word deltas locally after installation.
- Add clearly labeled estimated history based on current file modification dates.
- Add recent notes, open-task summaries, and top-level folder structure.
- Add light/dark Nord-inspired styling using scoped Obsidian theme variables.
