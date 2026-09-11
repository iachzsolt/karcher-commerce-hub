import { useRef, useState } from 'react'

export type TrendChartPoint = {
  bucket: string
  values: Record<string, number | null>
}

export type TrendChartSeries = {
  key: string
  label: string
  color: string
  axis: 'left' | 'right'
  format: (value: number | null) => string
}

const CHART_WIDTH = 720
const CHART_HEIGHT = 240
const PADDING = {
  top: 12,
  right: 52,
  bottom: 28,
  left: 52,
}

function axisScale(values: number[]): {
  min: number
  max: number
} {
  if (values.length === 0) {
    return { min: 0, max: 1 }
  }

  const min = Math.min(0, ...values)
  const max = Math.max(...values)
  const span = max - min || 1

  return {
    min,
    max: max + span * 0.1,
  }
}

function ArukeresoTrendChart({
  points,
  series,
}: {
  points: TrendChartPoint[]
  series: TrendChartSeries[]
}) {
  const [hoverIndex, setHoverIndex] =
    useState<number | null>(null)
  const svgRef =
    useRef<SVGSVGElement | null>(null)

  function formatBucket(bucket: string): string {
    if (/^\d{4}-W\d{2}$/.test(bucket)) {
      return bucket.slice(5)
    }

    if (/^\d{4}-\d{2}$/.test(bucket)) {
      return bucket.slice(2)
    }

    return bucket.slice(5)
  }

  const plotWidth =
    CHART_WIDTH - PADDING.left - PADDING.right
  const plotHeight =
    CHART_HEIGHT - PADDING.top - PADDING.bottom

  const leftValues = points.flatMap((point) =>
    series
      .filter(
        (item) =>
          item.axis === 'left' &&
          point.values[item.key] !== null,
      )
      .map(
        (item) =>
          point.values[item.key] as number,
      ),
  )
  const rightValues = points.flatMap((point) =>
    series
      .filter(
        (item) =>
          item.axis === 'right' &&
          point.values[item.key] !== null,
      )
      .map(
        (item) =>
          point.values[item.key] as number,
      ),
  )
  const left = axisScale(leftValues)
  const right = axisScale(rightValues)

  const xOf = (index: number) =>
    points.length === 1
      ? PADDING.left + plotWidth / 2
      : PADDING.left +
        (index / (points.length - 1)) *
          plotWidth
  const yOf = (
    value: number,
    scale: { min: number; max: number },
  ) =>
    PADDING.top +
    plotHeight -
    ((value - scale.min) /
      (scale.max - scale.min)) *
      plotHeight

  function linePath(
    item: TrendChartSeries,
  ): string {
    const scale =
      item.axis === 'left' ? left : right
    let path = ''
    let open = false

    points.forEach((point, index) => {
      const value = point.values[item.key]

      if (value === null || value === undefined) {
        open = false
        return
      }

      const command = `${open ? 'L' : 'M'}${xOf(index).toFixed(1)},${yOf(
        value,
        scale,
      ).toFixed(1)}`
      path += (path === '' ? '' : ' ') + command
      open = true
    })

    return path
  }

  const labelEvery = Math.max(
    1,
    Math.ceil(points.length / 8),
  )
  const hovered =
    hoverIndex !== null
      ? points[hoverIndex]
      : null

  function indexFromClientX(clientX: number): number {
    const rect =
      svgRef.current?.getBoundingClientRect()

    if (!rect || rect.width === 0) {
      return 0
    }

    const relative =
      ((clientX - rect.left) / rect.width) *
      CHART_WIDTH
    const ratio =
      (relative - PADDING.left) / plotWidth

    return Math.max(
      0,
      Math.min(
        points.length - 1,
        Math.round(
          ratio * (points.length - 1),
        ),
      ),
    )
  }

  return (
    <div className="ap-chart">
      <div className="ap-chart-legend">
        {series.map((item) => (
          <span key={item.key}>
            <b
              style={{
                background: item.color,
              }}
            />
            {item.label}
          </span>
        ))}
      </div>

      <div className="ap-chart-body">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          role="img"
          aria-label="Teljesítmény trend"
          onMouseMove={(event) =>
            setHoverIndex(
              indexFromClientX(event.clientX),
            )
          }
          onMouseLeave={() =>
            setHoverIndex(null)
          }
        >
          {[0, 1, 2, 3].map((line) => {
            const y =
              PADDING.top +
              (plotHeight / 3) * line

            return (
              <g key={line}>
                <line
                  x1={PADDING.left}
                  x2={CHART_WIDTH - PADDING.right}
                  y1={y}
                  y2={y}
                  stroke="#ededed"
                  strokeWidth="1"
                />
                <text
                  x={PADDING.left - 8}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="10"
                  fill="#777"
                >
                  {Math.round(
                    left.max -
                      ((left.max - left.min) / 3) *
                        line,
                  )}
                </text>
                {series.some(
                  (item) => item.axis === 'right',
                ) && (
                  <text
                    x={
                      CHART_WIDTH -
                      PADDING.right +
                      8
                    }
                    y={y + 4}
                    fontSize="10"
                    fill="#777"
                  >
                    {Math.round(
                      right.max -
                        ((right.max - right.min) /
                          3) *
                          line,
                    )}
                  </text>
                )}
              </g>
            )
          })}

          {series.map((item) => (
            <g key={item.key}>
              <path
                d={linePath(item)}
                fill="none"
                stroke={item.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {points.map((point, index) => {
                const value =
                  point.values[item.key]

                if (value === null) {
                  return null
                }

                const scale =
                  item.axis === 'left'
                    ? left
                    : right

                return (
                  <circle
                    key={index}
                    cx={xOf(index)}
                    cy={yOf(value, scale)}
                    r={
                      hovered === point ? 4 : 2.5
                    }
                    fill={item.color}
                    stroke="#fff"
                    strokeWidth="1"
                  />
                )
              })}
            </g>
          ))}

          {points.map((point, index) =>
            index % labelEvery === 0 ||
            index === points.length - 1 ? (
              <text
                key={point.bucket}
                x={xOf(index)}
                y={CHART_HEIGHT - 8}
                textAnchor="middle"
                fontSize="10"
                fill="#777"
              >
                {formatBucket(point.bucket)}
              </text>
            ) : null,
          )}
        </svg>

        {hovered && (
          <div className="ap-chart-tooltip">
            <strong>{hovered.bucket}</strong>
            {series.map((item) => (
              <span key={item.key}>
                <b
                  style={{
                    background: item.color,
                  }}
                />
                {item.label}:{' '}
                {item.format(
                  hovered.values[item.key] ??
                    null,
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default ArukeresoTrendChart
