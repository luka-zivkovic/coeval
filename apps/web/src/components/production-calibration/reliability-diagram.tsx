import type { ProductionCalibrationReliabilityBin } from "@rubrist/shared";
import { formatPercent, reliabilityDiagramLayout } from "../../lib/production-calibration-ui.js";

export interface ReliabilityDiagramProps {
  bins: readonly ProductionCalibrationReliabilityBin[];
  /** What the x axis measures: the boolean probability or the choice confidence. */
  predictedLabel?: string;
  observedLabel?: string;
  title?: string;
}

/**
 * Reliability diagram as inline SVG: predicted on x, observed rate on y, the
 * diagonal as the calibrated reference. Each populated bin is one mark sized
 * by its count, with its 95% Wilson interval drawn as a thin vertical range.
 * Colors come from the theme tokens so the figure reads in light and dark.
 */
export function ReliabilityDiagram({
  bins,
  predictedLabel = "Mean predicted probability",
  observedLabel = "Observed rate",
  title = "Reliability diagram"
}: ReliabilityDiagramProps) {
  const layout = reliabilityDiagramLayout(bins);
  const { plot } = layout;
  const summary = layout.points.length === 0
    ? "No bin has an outcome yet."
    : `${layout.points.length} populated bin${layout.points.length === 1 ? "" : "s"}${layout.emptyBins ? ` · ${layout.emptyBins} empty` : ""}`;
  return (
    <figure className="m-0 min-w-0">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width="100%"
        role="img"
        aria-label={`${title}: ${summary}`}
        className="block max-w-[420px] font-mono text-ink-3"
        style={{ height: "auto" }}
      >
        <title>{title}</title>
        {layout.ticks.map((tick) => (
          <g key={tick.value}>
            <line x1={tick.x} x2={tick.x} y1={plot.top} y2={plot.bottom} stroke="var(--rule-soft)" strokeWidth={1} />
            <line x1={plot.left} x2={plot.right} y1={tick.y} y2={tick.y} stroke="var(--rule-soft)" strokeWidth={1} />
            <text x={tick.x} y={plot.bottom + 16} textAnchor="middle" fontSize={10} fill="currentColor">{tick.label}</text>
            <text x={plot.left - 8} y={tick.y + 3} textAnchor="end" fontSize={10} fill="currentColor">{tick.label}</text>
          </g>
        ))}
        <line
          x1={plot.left}
          y1={plot.bottom}
          x2={plot.right}
          y2={plot.top}
          stroke="var(--rule-strong)"
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />
        <text x={plot.right} y={plot.top + 12} textAnchor="end" fontSize={9.5} fill="currentColor">calibrated</text>
        <line x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} stroke="var(--rule)" strokeWidth={1} />
        <line x1={plot.left} x2={plot.left} y1={plot.top} y2={plot.bottom} stroke="var(--rule)" strokeWidth={1} />
        {layout.points.map((point) => (
          <g key={point.index}>
            <line
              x1={point.x}
              x2={point.x}
              y1={point.yUpper}
              y2={point.yLower}
              stroke="var(--ink-3)"
              strokeWidth={1.25}
              strokeLinecap="round"
            />
            <circle
              cx={point.x}
              cy={point.y}
              r={point.radius}
              fill="var(--ink)"
              stroke="var(--card-raw)"
              strokeWidth={2}
            >
              <title>
                {`bin ${point.index + 1}: predicted ${formatPercent(point.meanPredicted)}, observed ${formatPercent(point.observedRate)} [${formatPercent(point.lower)}, ${formatPercent(point.upper)}], ${point.label}`}
              </title>
            </circle>
            <text
              x={point.x + point.radius + 4}
              y={point.y + 3.5}
              fontSize={9.5}
              fill="currentColor"
              textAnchor={point.x > plot.right - 44 ? "end" : "start"}
              dx={point.x > plot.right - 44 ? -(2 * point.radius + 8) : 0}
            >
              {point.label}
            </text>
          </g>
        ))}
        <text x={(plot.left + plot.right) / 2} y={layout.height - 8} textAnchor="middle" fontSize={10} fill="currentColor">
          {predictedLabel}
        </text>
        <text
          x={12}
          y={(plot.top + plot.bottom) / 2}
          textAnchor="middle"
          fontSize={10}
          fill="currentColor"
          transform={`rotate(-90 12 ${(plot.top + plot.bottom) / 2})`}
        >
          {observedLabel}
        </text>
      </svg>
      <figcaption className="mt-1 font-mono text-[10px] text-ink-4">
        {summary}. Mark size follows bin count; the vertical range is the 95% Wilson interval of the observed rate.
      </figcaption>
    </figure>
  );
}
