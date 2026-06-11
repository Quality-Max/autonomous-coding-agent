/**
 * QualityMax brand pyramid mark — the solid-fill indigo pyramid lifted from the
 * official QualityMax logo (qa-rag-app `qualitymax-logo-color.svg`). Only the
 * pyramid (the 0–150 x-range of the full lockup) is kept; the wordmark is
 * rendered as text alongside it in the header.
 */
interface Props {
  size?: number;
  className?: string;
}

export default function PyramidLogo({ size = 26, className }: Props) {
  const height = (size * 132) / 150;
  return (
    <svg
      width={size}
      height={height}
      viewBox="0 0 150 132"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path d="M131.5 98L75 18.5L18.5 98L75 121L131.5 98Z" fill="white" />
      <path d="M74.9998 116.634V25.1908L128.104 96.4809L74.9998 116.634Z" fill="#E0DFFF" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M150 103.237L75 132L0 103.237L75 0L150 103.237ZM23.7988 96.1783L75 115.814L126.201 96.1783L117.099 83.6503L75.2517 99.6991L33.0096 83.4993L23.7988 96.1783ZM42.2062 70.8399L75.2517 83.513L107.902 70.9914L98.2409 57.6924L75 66.6057L51.7576 57.6919L42.2062 70.8399ZM60.9542 45.0331L75 50.4196L89.0448 45.0331L75 25.7006L60.9542 45.0331Z"
        fill="#4E46DA"
      />
      <path
        d="M75 25.7006L60.9542 45.0331L75 50.4196V66.6057L51.7576 57.6919L42.2062 70.8399L75 83.4161V99.6022L33.0096 83.4993L23.7988 96.1783L75 115.814V132L0 103.237L75 0V25.7006Z"
        fill="#726AFF"
      />
    </svg>
  );
}
