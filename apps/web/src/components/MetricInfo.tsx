import {
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'

function MetricInfo({
  label,
  text,
  align = 'left',
}: {
  label: string
  text: string
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const tooltipId = useId()
  const rootRef =
    useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    function onPointerDown(event: PointerEvent) {
      if (
        rootRef.current &&
        !rootRef.current.contains(
          event.target as Node,
        )
      ) {
        setOpen(false)
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener(
      'pointerdown',
      onPointerDown,
    )
    document.addEventListener(
      'keydown',
      onKeyDown,
    )

    return () => {
      document.removeEventListener(
        'pointerdown',
        onPointerDown,
      )
      document.removeEventListener(
        'keydown',
        onKeyDown,
      )
    }
  }, [open])

  return (
    <span
      className={`metric-info${
        align === 'right'
          ? ' metric-info-right'
          : ''
      }`}
      ref={rootRef}
    >
      <button
        type="button"
        className="metric-info-button"
        aria-label={`${label}: magyarázat`}
        aria-expanded={open}
        aria-describedby={tooltipId}
        onClick={() =>
          setOpen((current) => !current)
        }
      >
        i
      </button>
      <span
        role="tooltip"
        id={tooltipId}
        className="metric-info-popup"
      >
        {text}
      </span>
    </span>
  )
}

export default MetricInfo
