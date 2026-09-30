#!/usr/bin/env python3
"""Render the FrontierHarness-style comparison chart from a comparison dataset.

The official FrontierHarness v1.0 scatter plots pass rate against either cost per pass
or median time per successful task, on a dark theme, with one coloured+shaped marker per
harness and an orange Pareto line over the official field. This script reproduces that
style for the dataset built by scripts/frontier-harness-comparison.mjs, which contains
the published rows plus this repository's own run as one extra point.

The extra point is drawn in its own style and the figure carries the model/runtime
difference in its caption, because the published field is one model on one runtime and
the self-run is not leaderboard-comparable.

Usage:
  chart.py --dataset <comparison.json> --view cost  --out <cost-vs-pass-rate.png>
  chart.py --dataset <comparison.json> --view speed --out <speed-vs-pass-rate.png>
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

BACKGROUND = "#0a0a0c"
PANEL = "#101014"
GRID = "#26262c"
TEXT = "#e8e8ea"
MUTED = "#9a9aa2"
ACCENT = "#ff6418"

MARKERS = {
    "circle": "o",
    "triangle": "^",
    "square": "s",
    "diamond": "D",
    "hexagon": "h",
    "star": "*",
}


def format_cost(value: float) -> str:
    return f"${value:,.2f}" if value >= 1 else f"${value:.4f}"


def format_seconds(value: float) -> str:
    total = int(round(value))
    return f"{total // 60}m {total % 60:02d}s"


def pareto(points: list[dict], metric: str) -> list[dict]:
    """Keep the cheapest/fastest-to-best-pass-rate staircase of the official field."""
    ordered = sorted(points, key=lambda point: point[metric])
    frontier, best = [], -math.inf
    for point in ordered:
        if point["passRate"] > best:
            frontier.append(point)
            best = point["passRate"]
    return frontier


def render(dataset: dict, view: str, out_path: Path) -> None:
    metric = "costPerPass" if view == "cost" else "medianSuccessfulSeconds"
    field = dataset["officialHarnesses"]
    point = dataset["point"]

    figure, axes = plt.subplots(figsize=(11.5, 6.6), dpi=200)
    figure.patch.set_facecolor(BACKGROUND)
    axes.set_facecolor(PANEL)
    for spine in axes.spines.values():
        spine.set_color(GRID)
    axes.grid(True, linestyle=(0, (1, 3)), linewidth=0.7, color=GRID, zorder=0)
    axes.set_axisbelow(True)

    if view == "cost":
        axes.set_xscale("log")
        ticks = [1, 2, 5, 10, 20]
        axes.set_xticks(ticks)
        axes.set_xticklabels([f"${tick}" for tick in ticks])
        axes.set_xlabel("Cost per pass (USD, log scale)", color=TEXT, fontsize=11, labelpad=10)
    else:
        values = [item[metric] for item in field] + [point[metric]]
        low, high = min(values), max(values)
        ticks = [tick for tick in range(300, 1000, 100) if low - 60 <= tick <= high + 60]
        axes.set_xticks(ticks)
        axes.set_xticklabels([format_seconds(tick) for tick in ticks])
        axes.set_xlabel("Median time per successful task", color=TEXT, fontsize=11, labelpad=10)

    for harness in field:
        axes.scatter(
            harness[metric],
            harness["passRate"] * 100,
            marker=MARKERS[harness["shape"]],
            s=170,
            color=harness["color"],
            edgecolors="#00000060",
            linewidths=0.8,
            zorder=3,
        )
        label = f"{harness['label']}\n{harness['passRate'] * 100:.1f}% · " + (
            format_cost(harness[metric]) if view == "cost" else format_seconds(harness[metric])
        )
        axes.annotate(
            label,
            (harness[metric], harness["passRate"] * 100),
            textcoords="offset points",
            xytext=(0, 15),
            ha="center",
            va="bottom",
            fontsize=7.2,
            color=TEXT,
            linespacing=1.35,
            zorder=4,
        )

    frontier = pareto(field, metric)
    axes.plot(
        [item[metric] for item in frontier],
        [item["passRate"] * 100 for item in frontier],
        color=ACCENT,
        linewidth=1.4,
        alpha=0.85,
        zorder=2,
    )

    axes.scatter(
        [point[metric]],
        [point["passRate"] * 100],
        marker=MARKERS[point["shape"]],
        s=560,
        color=point["color"],
        edgecolors="#ffffff",
        linewidths=1.2,
        zorder=6,
    )
    axes.scatter(
        [point[metric]],
        [point["passRate"] * 100],
        marker="o",
        s=1500,
        facecolors="none",
        edgecolors=point["color"],
        linewidths=1.0,
        alpha=0.5,
        zorder=5,
    )
    axes.annotate(
        f"{point['label']} · {point['sublabel']}\n"
        f"{point['passes']}/{point['cells']} passed ({point['passRate'] * 100:.1f}%) · "
        + (format_cost(point[metric]) if view == "cost" else format_seconds(point[metric])),
        (point[metric], point["passRate"] * 100),
        textcoords="offset points",
        xytext=(0, -34),
        ha="center",
        va="top",
        fontsize=8.4,
        color=point["color"],
        weight="bold",
        linespacing=1.4,
        zorder=7,
    )

    axes.set_ylabel("Pass rate", color=TEXT, fontsize=11, labelpad=10)
    rates = [harness["passRate"] * 100 for harness in field] + [point["passRate"] * 100]
    low, high = min(rates) - 6, max(rates) + 8
    axes.set_ylim(low, high)
    ticks = [tick for tick in range(40, 95, 5) if low <= tick <= high]
    axes.set_yticks(ticks)
    axes.set_yticklabels([f"{tick:.1f}%" for tick in ticks])
    axes.tick_params(colors=MUTED, labelsize=9)

    axes.set_title(
        "FrontierHarness Eval v1.0 — pass rate vs "
        + ("cost per pass" if view == "cost" else "median time per successful task"),
        color=TEXT,
        fontsize=13,
        pad=16,
        loc="left",
    )
    official = dataset["provenance"]["officialSource"]
    caption = (
        "Official field (coloured markers, orange Pareto line): 12 published configurations of "
        f"{official['modelLabel']} — {official['resultsFile'].split('/')[-1]} "
        f"generated {official['resultsGeneratedAt'][:10]}.\n"
        f"{point['label']} ({point['color']}-outlined star): {point['sublabel']}, this repository's own diagnostic "
        "self-run on GitHub-hosted runners — a different model AND a different runtime, so it is NOT a "
        "leaderboard-comparable result; it is shown next to the field, never inside its ranking."
    )
    figure.text(0.012, 0.022, caption, color=MUTED, fontsize=7.4, linespacing=1.5, ha="left", va="bottom")

    handles = [
        Line2D([], [], marker=MARKERS[harness["shape"]], color=harness["color"], linestyle="",
               markersize=7, label=harness["label"])
        for harness in field
    ]
    handles.append(
        Line2D([], [], marker=MARKERS[point["shape"]], color=point["color"], linestyle="",
               markersize=11, markeredgecolor="#ffffff", markeredgewidth=0.8, label=point["label"])
    )
    legend = axes.legend(
        handles=handles,
        loc="lower right",
        ncol=2,
        frameon=True,
        fontsize=7.6,
        facecolor=PANEL,
        edgecolor=GRID,
        labelcolor=TEXT,
    )
    legend.get_frame().set_alpha(0.95)

    figure.subplots_adjust(left=0.075, right=0.985, top=0.9, bottom=0.2)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(out_path, facecolor=BACKGROUND)
    plt.close(figure)
    print(f"wrote {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--view", required=True, choices=["cost", "speed"])
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    render(json.loads(Path(args.dataset).read_text()), args.view, Path(args.out))


if __name__ == "__main__":
    main()
